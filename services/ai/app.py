import os
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, List

app = FastAPI(title="redcliff-ai", version="0.1.0")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "")


class NarrativeInput(BaseModel):
    actor: str
    action: str
    result: str
    mood: str = "epic"
    actor_role: str = "officer"  # officer | governor | vassal | ronin (best-effort)
    target: Optional[str] = None
    perspective: str = "officer"  # fixed: this game is officer-centric
    forbid_phrases: Optional[List[str]] = None
    # Optional context/RAG (kept small and factual)
    objective: Optional[str] = None
    time: Optional[str] = None
    location: Optional[str] = None
    lore: Optional[List[dict]] = None  # [{title, body, source}]

    class Config:
        extra = "ignore"


@app.get('/health')
def health():
    return {"ok": True}


@app.post('/narrate')
def narrate(payload: NarrativeInput):
    if not OPENAI_API_KEY:
        text = (
            f"{payload.actor}의 행동({payload.action}) 결과: {payload.result}. "
            "난세의 기록관은 이를 비장한 승전보로 남겼다."
        )
        return {"text": text, "provider": "template"}

    from openai import OpenAI

    kwargs = {"api_key": OPENAI_API_KEY}
    if OPENAI_BASE_URL:
        kwargs["base_url"] = OPENAI_BASE_URL
    client = OpenAI(**kwargs)

    # Officer-centric style guide (user explicitly does NOT want ruler/lord fantasy).
    # Key constraint: never phrase social actions as "a lord bestows -> loyalty pledge".
    forbid = payload.forbid_phrases or [
        "하사", "내리니", "내리다", "충성을 맹세", "충성 맹세", "주군", "신하", "군주께서", "명하여",
        "책봉", "봉작", "하달", "조칙", "어명", "황제"
    ]
    forbid_line = ", ".join(forbid)

    action = (payload.action or "").strip()
    is_pledge = action.startswith("pledge")

    # System prompt keeps it short, modern, and strictly from an officer POV.
    system_prompt = (
        "너는 삼국지 세계의 '기록관'이지만, 이 게임은 군주가 아니라 '장수 1인 시점' RPG다.\n"
        "규칙/판정은 이미 서버에서 확정됐다. 너는 결과를 '표현'만 한다.\n"
        "반드시 지켜라:\n"
        f"- 금지어/금지표현: {forbid_line}\n"
        "- 선물/연회/교류는 '동료 장수 간 호의/신뢰/친분'으로만 묘사한다. (권력관계 암시 금지)\n"
        "- 1~2문장, 과장/미사여구 과다 금지. 직관적이고 쉬운 문장.\n"
        "- 결과 숫자/요약은 바꾸지 말고, 의미만 덧붙여라.\n"
        "- '충성'이라는 단어는 pledge(임관) 같은 행동일 때만 제한적으로 허용한다.\n"
    )
    if is_pledge:
        system_prompt += "- pledge는 '임관/합류'로 표현하되, 과도한 군주 미화는 금지.\n"

    user_prompt = (
        f"행동자: {payload.actor} (role={payload.actor_role})\n"
        f"대상: {payload.target or '-'}\n"
        f"위치: {payload.location or '-'}\n"
        f"시간: {payload.time or '-'}\n"
        f"현재 목표: {payload.objective or '-'}\n"
        f"행동: {payload.action}\n"
        f"결과: {payload.result}\n"
        f"분위기: {payload.mood}\n"
        "위 정보를 바탕으로 1~2문장 내러티브를 작성하라."
    )

    lore_lines = []
    try:
        if payload.lore:
            for it in payload.lore[:6]:
                title = str(it.get("title") or "").strip()
                body = str(it.get("body") or "").strip()
                if not (title or body):
                    continue
                line = f"- {title}: {body}" if title else f"- {body}"
                lore_lines.append(line[:500])
    except Exception:
        lore_lines = []
    if lore_lines:
        user_prompt += "\n\n세계지식(사실, 요약):\n" + "\n".join(lore_lines)
    try:
        completion = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.7,
        )
        text = completion.choices[0].message.content or payload.result
        return {"text": text, "provider": "openai-compatible"}
    except Exception:
        text = (
            f"{payload.actor}의 행동({payload.action}) 결과: {payload.result}. "
            "기록관은 이를 난세의 전공으로 간결히 남겼다."
        )
        return {"text": text, "provider": "template-fallback"}
