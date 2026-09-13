from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Action(str, Enum):
    CONNECT = "connect"
    DISCONNECT = "disconnect"
    NONE = "none"


@dataclass(frozen=True)
class Snapshot:
    webgpt_process: bool
    bridge_listening: bool
    route_active: bool
    runtime_ready: bool | None = None

    @property
    def webgpt_healthy(self) -> bool:
        return self.webgpt_process and self.bridge_listening and self.runtime_ready is not False


def decide_route_action(
    snapshot: Snapshot,
    *,
    restart_grace: bool = False,
    user_off: bool = False,
) -> Action:
    """App+bridge healthy → route on. App closed or user-off → route off.

    Closing the Web GPT window must not keep an orphan 17841 serve routed.
    A brief restart (process still up, port down) can keep the stale route
    only while ``restart_grace`` is True.
    """
    if user_off:
        return Action.DISCONNECT if snapshot.route_active else Action.NONE
    if snapshot.webgpt_healthy:
        return Action.NONE if snapshot.route_active else Action.CONNECT
    if snapshot.route_active:
        if restart_grace and snapshot.webgpt_process:
            return Action.NONE
        return Action.DISCONNECT
    return Action.NONE
