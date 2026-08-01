# FIXLOG

- 2026-08-01 / 非授权 Telegram turn 会把共享 Codex 线程临时切成 readOnly，connector 若在恢复前退出，本地 TUI 会永久残留只读权限 / turn/start 对共享线程施加了持久化的权限覆盖，再依赖 turn 完成后的反向覆盖恢复 / Telegram turn 不再覆盖 approvalPolicy 或 sandboxPolicy，只保留逐消息 mayExecute=false 与审批自动拒绝
