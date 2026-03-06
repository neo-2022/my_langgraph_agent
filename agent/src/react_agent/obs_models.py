from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Severity = Literal["debug", "info", "warn", "error", "fatal"]

class AttachmentMeta(BaseModel):
    id: str
    filename: str
    mime: str
    size: int
    digest: Optional[str]

    model_config = ConfigDict(extra="ignore")

class RawEventModel(BaseModel):
    schema_version: str
    event_id: str
    session_id: Optional[str]
    sequence_id: Optional[int]
    timestamp: str
    kind: str
    scope: str
    severity: Severity
    title: Optional[str]
    message: str
    payload: Dict[str, Any] = Field(default_factory=dict)
    context: Dict[str, Any] = Field(default_factory=dict)
    tags: List[str] = Field(default_factory=list)
    attrs: Dict[str, Any] = Field(default_factory=dict)
    attachments: Optional[List[AttachmentMeta]]
    content_hash: Optional[str]
    version_history: Optional[List[str]]
    trace_id: Optional[str] = None
    retry_count: int = Field(default=0, ge=0)

    model_config = ConfigDict(extra="ignore")
