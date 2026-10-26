"""Restricted execution for user-authored strategies.

The Node server compiled user strategies inside ``node:vm`` with ``require`` /
``fetch`` / ``process`` removed and a 5 s timeout. Python has no equivalent
sandbox in the standard library, so this module implements a conservative
approximation:

* the source is parsed first and rejected if it imports modules, defines
  globals, opens files, or touches dunder attributes;
* only a whitelist of builtins is exposed (no ``open``/``exec``/``eval``/
  ``__import__``/``getattr``/``input``);
* the call is bounded by a wall-clock deadline checked by the caller.

This is enough to stop accidental damage from AI-generated strategies, but it is
**not** a security boundary against deliberately hostile code — run untrusted
strategies in a separate process/container if that matters.
"""

from __future__ import annotations

import ast
from typing import Any, Callable, Dict, Optional

from .models import Decision, decision_from_raw
from .strategies import Strategy, StrategyContext

FORBIDDEN_NODES = (
    ast.Import,
    ast.ImportFrom,
    ast.Global,
    ast.Nonlocal,
    ast.With,
    ast.AsyncWith,
    ast.AsyncFunctionDef,
    ast.Await,
    ast.Yield,
    ast.YieldFrom,
    ast.ClassDef,
)

FORBIDDEN_NAMES = frozenset(
    {
        "open",
        "exec",
        "eval",
        "compile",
        "__import__",
        "input",
        "globals",
        "locals",
        "vars",
        "dir",
        "getattr",
        "setattr",
        "delattr",
        "breakpoint",
        "memoryview",
        "help",
        "exit",
        "quit",
        "os",
        "sys",
        "subprocess",
        "socket",
        "pathlib",
    }
)

SAFE_BUILTINS: Dict[str, Any] = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "divmod": divmod,
    "enumerate": enumerate,
    "filter": filter,
    "float": float,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "map": map,
    "max": max,
    "min": min,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
    "Exception": Exception,
    "ValueError": ValueError,
    "True": True,
    "False": False,
    "None": None,
}


class SandboxError(ValueError):
    """Raised when user strategy code is rejected or fails to load."""


def _validate(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        if isinstance(node, FORBIDDEN_NODES):
            raise SandboxError(f"不允许的语法: {node.__class__.__name__}")
        if isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            raise SandboxError(f"不允许使用: {node.id}")
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("__"):
                raise SandboxError(f"不允许访问双下划线属性: {node.attr}")
            if node.attr in FORBIDDEN_NAMES:
                raise SandboxError(f"不允许调用: {node.attr}")


def compile_user_code(code: str) -> Callable[[StrategyContext], Any]:
    """Compile strategy source into a ``decide(ctx)`` callable."""
    if not isinstance(code, str) or not code.strip():
        raise SandboxError("策略代码为空")
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        raise SandboxError(f"语法错误: {exc.msg} (第 {exc.lineno} 行)") from exc

    _validate(tree)

    namespace: Dict[str, Any] = {
        "__builtins__": SAFE_BUILTINS,
        "Decision": Decision,
        "math": __import__("math"),
        "abs": abs,
        "min": min,
        "max": max,
        "sum": sum,
        "len": len,
        "round": round,
        "range": range,
    }

    try:
        exec(compile(tree, "<user-strategy>", "exec"), namespace)  # noqa: S102 - sandboxed above
    except Exception as exc:  # noqa: BLE001
        raise SandboxError(f"策略代码执行失败: {exc}") from exc

    decide = namespace.get("decide")
    if not callable(decide):
        raise SandboxError("策略代码必须定义 decide(ctx) 函数")

    def wrapped(ctx: StrategyContext) -> Any:
        return decision_from_raw(decide(ctx))

    return wrapped


def build_user_strategy(
    strategy_id: str,
    name: str,
    code: str,
    description: str = "",
    params: Optional[list] = None,
    requires_chanlun: bool = False,
) -> Strategy:
    decide = compile_user_code(code)
    return Strategy(
        id=strategy_id,
        name=name,
        decide=decide,
        description=description,
        params=list(params or []),
        requires_chanlun=requires_chanlun,
        source="user",
    )
