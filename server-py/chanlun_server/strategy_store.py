"""User strategy persistence (``data/user-strategies/<id>.json``).

Mirrors ``server/strategyStore.ts``: the store keeps the raw record (including
source code) so the UI can re-open and edit it, while the registry compiles it
into a runnable :class:`~chanlun_server.strategies.Strategy`.

Difference from the Node server: ``code`` is **Python** source defining
``decide(ctx)``, because the Python engine cannot execute the JavaScript that
the browser-side AI generates. Records written by the Node server carry a
``language`` field; anything not marked ``python`` is skipped with a warning
instead of being executed.
"""

from __future__ import annotations

import json
import pathlib
import re
import time
from typing import Any, Dict, List, Optional, Tuple

from . import config
from .sandbox import SandboxError, build_user_strategy
from .strategies import Strategy

STRATEGY_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")

#: 可被测试覆盖
STORE_DIR: pathlib.Path = config.USER_STRATEGY_DIR


class StrategyStoreError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _path(strategy_id: str) -> pathlib.Path:
    return STORE_DIR / f"{strategy_id}.json"


def _read_record(path: pathlib.Path) -> Optional[Dict[str, Any]]:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict) or not record.get("id"):
        return None
    return record


def list_stored_strategies() -> List[Dict[str, Any]]:
    if not STORE_DIR.is_dir():
        return []
    records: List[Dict[str, Any]] = []
    for path in sorted(STORE_DIR.glob("*.json")):
        record = _read_record(path)
        if record is not None:
            records.append(record)
    return records


def get_stored_strategy(strategy_id: str) -> Optional[Dict[str, Any]]:
    path = _path(strategy_id)
    if not path.is_file():
        return None
    return _read_record(path)


def _validate_payload(payload: Any, reserved_ids: Optional[set[str]] = None) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise StrategyStoreError("请求体必须是 JSON 对象")

    strategy_id = str(payload.get("id") or "").strip()
    if not STRATEGY_ID_RE.match(strategy_id):
        raise StrategyStoreError("id 必须是 2~64 位小写字母/数字/._-")
    if reserved_ids and strategy_id in reserved_ids:
        raise StrategyStoreError(f"id 与内置策略冲突: {strategy_id}", 409)

    name = str(payload.get("name") or "").strip()
    if not name:
        raise StrategyStoreError("name 不能为空")

    code = payload.get("code")
    if not isinstance(code, str) or not code.strip():
        raise StrategyStoreError("code 不能为空")

    language = str(payload.get("language") or "python").lower()
    if language != "python":
        raise StrategyStoreError(
            f"Python 服务端只能执行 Python 策略代码 (收到 language={language})"
        )

    # 编译一次: 语法/沙箱不通过的代码不入库
    try:
        build_user_strategy(strategy_id, name, code, description=str(payload.get("description") or ""))
    except SandboxError as exc:
        raise StrategyStoreError(f"策略代码未通过校验: {exc}") from exc

    params = payload.get("params")
    if params is not None and not isinstance(params, list):
        raise StrategyStoreError("params 必须是数组")

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    record: Dict[str, Any] = {
        "id": strategy_id,
        "name": name,
        "description": str(payload.get("description") or ""),
        "code": code,
        "language": "python",
        "params": params or [],
        "requiresChanLun": bool(payload.get("requiresChanLun")),
        "defaultSelected": bool(payload.get("defaultSelected")),
        "prompt": payload.get("prompt"),
        "model": payload.get("model"),
        "chatHistory": payload.get("chatHistory") or [],
        "createdAt": payload.get("createdAt") or now,
        "updatedAt": now,
    }
    return record


def save_stored_strategy(
    payload: Any, reserved_ids: Optional[set[str]] = None
) -> Dict[str, Any]:
    record = _validate_payload(payload, reserved_ids)
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    target = _path(record["id"])
    existing = get_stored_strategy(record["id"])
    if existing and existing.get("createdAt"):
        record["createdAt"] = existing["createdAt"]
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(target)
    return record


def delete_stored_strategy(strategy_id: str) -> bool:
    path = _path(strategy_id)
    if not path.is_file():
        return False
    try:
        path.unlink()
    except OSError:
        return False
    return True


def import_stored_strategies(payload: Any) -> Dict[str, Any]:
    """Bulk import; invalid records are reported, not fatal."""
    items = payload.get("strategies") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        raise StrategyStoreError("import 需要 strategies 数组")

    imported: List[str] = []
    errors: List[Dict[str, str]] = []
    for index, item in enumerate(items):
        try:
            record = save_stored_strategy(item)
            imported.append(record["id"])
        except StrategyStoreError as exc:
            errors.append({"index": str(index), "error": str(exc)})
    return {"imported": imported, "errors": errors}


def user_strategy_source(record: Dict[str, Any]) -> Dict[str, Any]:
    """Payload for the "view source" dialog."""
    return {
        "id": record.get("id"),
        "name": record.get("name"),
        "code": record.get("code", ""),
        "language": record.get("language", "python"),
        "source": "user",
        "updatedAt": record.get("updatedAt"),
    }


def load_user_strategies() -> List[Strategy]:
    """Compile every stored record; broken ones are skipped with a warning."""
    strategies: List[Strategy] = []
    for record in list_stored_strategies():
        if str(record.get("language") or "python").lower() != "python":
            print(
                f"[strategyStore] 跳过 {record.get('id')}: 该记录是 "
                f"{record.get('language')} 代码, Python 服务端无法执行"
            )
            continue
        try:
            strategies.append(
                build_user_strategy(
                    strategy_id=str(record["id"]),
                    name=str(record.get("name") or record["id"]),
                    code=str(record.get("code") or ""),
                    description=str(record.get("description") or ""),
                    params=record.get("params") or [],
                    requires_chanlun=bool(record.get("requiresChanLun")),
                )
            )
        except (SandboxError, KeyError) as exc:
            print(f"[strategyStore] 跳过无法编译的策略 {record.get('id')}: {exc}")
    return strategies


def builtin_ids() -> set[str]:
    from .strategies import load_builtin_strategies

    return {s.id for s in load_builtin_strategies()}


def store_summary() -> Tuple[int, int]:
    """(records on disk, compilable records) — used by /api/health."""
    records = list_stored_strategies()
    return len(records), len(load_user_strategies())
