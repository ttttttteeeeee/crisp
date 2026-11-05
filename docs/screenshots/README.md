# Screenshots: backend hardening

These screenshots show the fixes for "Security on the admin API", "Proxy robustness" and "Engineering basics" from the project gap report.

| File | What it shows |
|---|---|
| `security-before-after.png` | The same `curl` requests sent to the server before and after the change. A cross-site `text/plain` POST used to create an attacker's route (201) and is now rejected (403). A foreign `Host` header used to be served (200) and is now rejected (421). Malformed percent-encoding used to cause a 500 and now returns a 400. |
| `tests-passing.png` | `npm test`: 16 passing tests with Node's built-in runner, covering validation, CSRF, DNS rebinding, proxying, response size limits and static pages. |
| `dashboard-after.png` | The admin dashboard still works under the new checks. Routes were created through its own same-origin requests, and proxied calls (200, 200, 404) appear in request activity. |
