---
name: ssh
description: Forward ports or serve web apps from an rlm.dispatch worker to the user's local browser.
---

Available only to the local foreground agent for `rlm.dispatch` workers.
Target: dispatch handle, `rlm.list_subagents()` entry, or worker name/ID.

```python
tunnel = await rlm.ssh(worker, args=["-L", "127.0.0.1:8080:localhost:3000"])
```

Accepts `-L` and `-N`; destination and credentials are supplied automatically.
`await tunnel.status()` reports `.running`; `await tunnel.close()` closes it.

Tunnels survive cells and turns; closing the owning session closes them.
Connections with no forwarding channels expire after 1 minute; idle channels
expire after 5 minutes. No automatic reconnect.
