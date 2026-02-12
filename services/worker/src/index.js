import { Worker } from 'bullmq';
import Redis from 'ioredis';
import axios from 'axios';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { Pool } = pg;

const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const queueName = process.env.BIOGRAPHY_QUEUE || 'biography';
const aiUrl = process.env.AI_URL || 'http://ai:8000';
const portraitQueueName = process.env.PORTRAIT_QUEUE || 'portraits';

async function fetchLoreForNarration({ officerId, actor, command, target }) {
  const tags = [];
  const push = (x) => {
    const s = String(x || '').trim();
    if (s) tags.push(s);
  };
  push(officerId);
  push(actor);
  push(command);
  push(target);

  // Pull current location + story objective for better anchoring.
  let location = null;
  let objective = null;
  let time = null;
  try {
    const row = await pool.query(
      `SELECT o.city_id, c.name_kr AS city_name, o.force_id, ss.objective AS objective
       FROM officers o
       JOIN cities c ON c.id = o.city_id
       LEFT JOIN story_states ss ON ss.officer_id = o.id
       WHERE o.id = $1
       LIMIT 1`,
      [officerId]
    );
    if (row.rows.length) {
      location = `${row.rows[0].city_name || row.rows[0].city_id || ''}`.trim() || null;
      objective = row.rows[0].objective ? String(row.rows[0].objective) : null;
      push(row.rows[0].city_id);
      push(row.rows[0].city_name);
      push(row.rows[0].force_id);
    }
  } catch {
    // ignore
  }
  try {
    const gt = await pool.query(`SELECT year, month, day FROM game_time WHERE id = 1`);
    const g = gt.rows[0];
    if (g) time = `${g.year}.${g.month}.${g.day}`;
  } catch {
    // ignore
  }

  const uniq = Array.from(new Set(tags)).slice(0, 18);
  const lore = [];
  const seen = new Set();
  const addLore = (r) => {
    const key = String(r.id || r.title || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    lore.push({ title: r.title, body: r.body, source: r.source });
  };

  // Primary: tag overlap (fast + deterministic).
  try {
    if (uniq.length) {
      const r = await pool.query(
        `SELECT id, title, body, source
         FROM lore_entries
         WHERE tags && $1::text[]
         ORDER BY updated_at DESC
         LIMIT 8`,
        [uniq]
      );
      for (const x of r.rows || []) addLore(x);
    }
  } catch {
    // ignore
  }

  // Secondary: title fuzzy match for actor/location if tags miss.
  try {
    const needles = [actor, location, target].map((x) => String(x || '').trim()).filter(Boolean);
    for (const n of needles.slice(0, 3)) {
      const r = await pool.query(
        `SELECT id, title, body, source
         FROM lore_entries
         WHERE title ILIKE $1
         ORDER BY updated_at DESC
         LIMIT 3`,
        [`%${n}%`]
      );
      for (const x of r.rows || []) addLore(x);
    }
  } catch {
    // ignore
  }

  return { lore: lore.slice(0, 6), location, objective, time };
}

new Worker(
  queueName,
  async (job) => {
    const {
      bioLogId = null,
      officerId,
      actor,
      command,
      summary,
      actorRole = 'officer',
      target = null,
      forbidPhrases = null
    } = job.data;

    const rag = await fetchLoreForNarration({ officerId, actor, command, target });

    const aiResp = await axios.post(`${aiUrl}/narrate`, {
      actor,
      action: command,
      result: summary,
      mood: 'heroic',
      actor_role: actorRole,
      target,
      forbid_phrases: forbidPhrases,
      lore: rag.lore,
      location: rag.location,
      objective: rag.objective,
      time: rag.time
    });

    if (bioLogId) {
      await pool.query(`UPDATE biography_logs SET narration = $1 WHERE id = $2`, [aiResp.data.text, bioLogId]);
    } else {
      // Backward-compatible fallback for older jobs.
      await pool.query(
        `UPDATE biography_logs
         SET narration = $1
         WHERE id = (
           SELECT id FROM biography_logs
           WHERE officer_id = $2
           ORDER BY created_at DESC
           LIMIT 1
         )`,
        [aiResp.data.text, officerId]
      );
    }
  },
  { connection: redis, concurrency: 5 }
);

console.log(`worker started: ${queueName}`);

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function runSdCli({
  sdcliPath,
  modelPath,
  prompt,
  negativePrompt,
  width,
  height,
  steps,
  cfgScale,
  guidance,
  samplingMethod,
  scheduler,
  seed,
  threads,
  outPath,
  timeoutMs
}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m',
      modelPath,
      '-p',
      prompt,
      '-n',
      negativePrompt || '',
      '-W',
      String(width),
      '-H',
      String(height),
      '--steps',
      String(steps),
      ...(cfgScale != null && Number.isFinite(Number(cfgScale)) ? ['--cfg-scale', String(cfgScale)] : []),
      ...(guidance != null && Number.isFinite(Number(guidance)) ? ['--guidance', String(guidance)] : []),
      ...(samplingMethod ? ['--sampling-method', String(samplingMethod)] : []),
      ...(scheduler ? ['--scheduler', String(scheduler)] : []),
      '--seed',
      String(seed),
      '--threads',
      String(threads),
      '--preview',
      'none',
      '-o',
      outPath
    ];

    const child = spawn(sdcliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`sd-cli timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`sd-cli exit code ${code}\n${stderr || stdout}`));
    });
  });
}

const portraitWorker = new Worker(
  portraitQueueName,
  async (job) => {
    const portraitId = String(job.data?.portraitId || '').trim();
    if (!portraitId) throw new Error('portrait job: missing portraitId');

    const rows = await pool.query(
      `SELECT id, officer_id, prompt, negative_prompt, size, width, height, steps, cfg_scale, sampling_method, scheduler, model_key, status, file_name
       FROM portraits
       WHERE id=$1`,
      [portraitId]
    );
    if (!rows.rows.length) throw new Error(`portrait job: not found id=${portraitId}`);
    const p = rows.rows[0];
    if (p.status === 'done' && p.file_name && existsSync(path.join(process.env.PORTRAITS_DIR || '/data/portraits', p.file_name))) {
      return;
    }

    const portraitsDir = process.env.PORTRAITS_DIR || '/data/portraits';
    const sdcliPath = process.env.SDCLI_PATH || '';
    const modelPath = process.env.SD_MODEL || '';
    if (!sdcliPath || !modelPath) {
      // Don't leave jobs stuck in "queued" forever if portraits integration isn't configured.
      await pool.query(
        `UPDATE portraits
         SET status='error',
             error=$2,
             updated_at=now()
         WHERE id=$1 AND status IN ('queued','running')`,
        [portraitId, 'portrait worker: SDCLI_PATH/SD_MODEL not configured']
      );
      throw new Error('portrait worker: SDCLI_PATH/SD_MODEL not configured');
    }

    const size = Number(p.size || 256);
    const width = Number(p.width || size);
    const height = Number(p.height || size);
    const steps = Number(p.steps || process.env.SD_STEPS || 20);
    const cfgScale = Number.isFinite(Number(p.cfg_scale)) ? Number(p.cfg_scale) : (process.env.SD_CFG_SCALE ? Number(process.env.SD_CFG_SCALE) : null);
    const guidance = process.env.SD_GUIDANCE ? Number(process.env.SD_GUIDANCE) : null;
    const samplingMethod = String(p.sampling_method || process.env.SD_SAMPLING_METHOD || '').trim() || null;
    const scheduler = String(p.scheduler || process.env.SD_SCHEDULER || '').trim() || null;
    const threads = Number(process.env.SD_THREADS || 4);
    const negativePrompt = String(p.negative_prompt || process.env.SD_NEGATIVE || '').trim();
    const prompt = String(p.prompt || '').trim();
    if (!prompt) throw new Error('portrait worker: empty prompt');

    const seed = Number.isFinite(Number(job.data?.seed)) ? Number(job.data.seed) : Math.abs(parseInt(sha256Hex(portraitId).slice(0, 8), 16));
    const tmpName = `${portraitId}.tmp.png`;
    const outName = p.file_name || `${portraitId}_${width}x${height}.png`;
    const tmpPath = path.join(portraitsDir, tmpName);
    const outPath = path.join(portraitsDir, outName);

    await fs.mkdir(portraitsDir, { recursive: true });
    await pool.query(`UPDATE portraits SET status='running', error=NULL, updated_at=now() WHERE id=$1`, [portraitId]);

    try {
      await runSdCli({
        sdcliPath,
        modelPath,
        prompt,
        negativePrompt,
        width,
        height,
        steps,
        cfgScale,
        guidance,
        samplingMethod,
        scheduler,
        seed,
        threads,
        outPath: tmpPath,
        timeoutMs: 20 * 60 * 1000
      });
      await fs.rename(tmpPath, outPath);
      await pool.query(
        `UPDATE portraits
         SET status='done', file_name=$2, error=NULL, updated_at=now()
         WHERE id=$1`,
        [portraitId, outName]
      );
    } catch (err) {
      // best-effort cleanup
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore
      }
      await pool.query(`UPDATE portraits SET status='error', error=$2, updated_at=now() WHERE id=$1`, [
        portraitId,
        err?.message ? String(err.message).slice(0, 2000) : String(err)
      ]);
      throw err;
    }
  },
  {
    connection: redis,
    concurrency: 1,
    lockDuration: 20 * 60 * 1000
  }
);

console.log(`worker started: ${portraitQueueName}`);

portraitWorker.on('failed', (job, err) => {
  const id = job?.id ? String(job.id) : 'unknown-job';
  const pid = job?.data?.portraitId ? String(job.data.portraitId) : 'unknown-portrait';
  console.error(`[portraits] job failed id=${id} portraitId=${pid} err=${err?.message || err}`);
});
