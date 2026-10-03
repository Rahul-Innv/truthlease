# Task inputs, Artifacts, Database, Usage and webhooks

Read this before integrating these capability groups. Production checks on 2026-10-03 exercised
Usage, Run Output, action detail and paging, the message-to-Artifact flow, and Agent webhook
registration, test delivery, redelivery and secret rotation with `@zoowork-ai/sdk` 0.10.x and
`zoowork` 0.5.x. Check the installed SDK exports/source first; do not assume an
older registry release contains a newly added method. If absent, use the corresponding documented
HTTP route with the existing backend client configuration. Do not upgrade or make live writes
merely to answer a capability question.

## Method mapping

| TypeScript | Python | Public contract |
|---|---|---|
| `getUsage({ range?, groupBy?, view?, perPage?, snapshot?, cursor? })` | `get_usage(range=..., group_by=..., view=..., per_page=..., snapshot=..., cursor=...)` | GET /service/v1/usage; current key scope |
| `getRunOutput(agentId, sessionId, runId, { cursor?, limit? })` | `get_run_output(agent_id, session_id, run_id, cursor=..., limit=...)` | One run's output, with completion and paging metadata |
| `getApproval(agentId, approvalId)` | `get_approval(agent_id, approval_id)` | Pending or terminal approval |
| `getCustomToolCall(agentId, callId)` | `get_custom_tool_call(agent_id, call_id)` | Pending or terminal application-executed tool call |
| `listApprovalPage(agentId, { status?, sessionId?, cursor?, limit? })` | `list_approval_page(agent_id, status=..., session_id=..., cursor=..., limit=...)` | Object with approvals, has_more, next_cursor |
| `listCustomToolCallPage(agentId, opts)` | `list_custom_tool_call_page(agent_id, **opts)` | Object with custom_tool_calls, has_more, next_cursor |

The production Database viewer is unavailable: catalog and table-row endpoints return 404
although the Agent's `agent_db` tool works. Do not generate viewer SDK or HTTP calls as a
working app flow. Ask the Agent to query with `agent_db` and return results in a Session or
publish a report Artifact. Those are Agent-mediated results, not direct application DB reads.

Use `range: '24h' | '7d' | '30d'`, `groupBy: 'session' | 'api_key'`, and
`view: 'groups' | 'records' | 'both'` for Usage. Other filters include session/key/root-session,
attribution, timezone, page, as-of and snapshot/cursor. Python uses snake_case for helper
parameters. Responses retain API spelling and unknown fields. Reporting does not enforce a
Session dollar cap. Production invalid Usage parameters can return 422 with a `detail` array
and no business error type (for example an invalid range or page size), or 400
`usage.invalid_query` for invalid timezone. Correct the query; do not retry unchanged.
`credits` uses Platform credits, at 200 credits/USD. Key-scoped consumption is not the
Organization balance or a complete Organization cost report; Organization admins see the balance
and Organization-wide usage, including shared sandbox costs, in Platform at
<https://platform.zoowork.ai>.

Action lists allow omitted or pending status. Original list methods still return arrays; page
methods opt into pagination and retain metadata. Detail reads do not require pending status.
Replay every cursor unchanged. Pending IDs in a Session projection include completeness flags;
if incomplete, page the authoritative action list. A resolution's signaled=true acknowledges
acceptance; it does not prove the run consumed the result.

Run Output contains text and artifact references. An artifact_id can be null; download only a
non-null ID through the Artifact API. Follow next_cursor while has_more is true. A running run
can have no next page and still be incomplete: require output_complete=true for a complete result.

## Text task inputs and file outputs

Read local text data in your application and include it in a Session `user.message`. Ask the
Agent to create files in `/workspace`, verify their contents and publish output using its
in-loop `artifact_publish` tool. The application downloads the published Artifact.
This is the flow in the public [Files guide](https://zoowork.ai/docs/build/files.md).
Direct workspace Files endpoints are outside the currently supported public workflow; an SDK
method or an offline test does not establish production availability. Do not use direct Files
calls as a setup, input, inspection or output-download step.

These examples reuse a running Agent and an initialized SDK client. Keep input text within
the documented message limits; this is not a binary upload, repository mount or registered
Skill upload. `persona.docs` holds standing instructions, rather than per-task data.

```ts
import { readFile, writeFile } from 'node:fs/promises'
import { isRunFinished, runOutcome } from '@zoowork-ai/sdk'

const csvText = await readFile('sales.csv', 'utf8')
const task = `Use the CSV below to create /workspace/report.md with a sales table and total.
Read the report back to verify it, then publish it with artifact_publish.
CSV data follows:\n${csvText}`
const session = await zc.createSession(agentId, {
  initial_events: [{ type: 'user.message', content: task }],
})
for await (const event of zc.streamEvents(agentId, session.session_id)) {
  if (isRunFinished(event)) {
    if (runOutcome(event) !== 'succeeded') throw new Error(`run ${runOutcome(event)}`)
    break
  }
}

let artifactId: string | undefined
for (let page = 1; ; page += 1) {
  const result = await zc.listArtifacts(agentId, {
    sessionId: session.session_id, sourcePath: '/workspace/report.md', page, limit: 50,
  })
  artifactId = result.artifacts.find((item) => item.status === 'ready')?.artifact_id
  if (artifactId || !result.has_more) break
}
if (!artifactId) throw new Error('No ready report Artifact')
const download = await zc.downloadArtifact(agentId, artifactId)
if (!download.url) throw new Error('No Artifact download URL')
const response = await fetch(download.url)
if (!response.ok) throw new Error(`Artifact download failed: ${response.status}`)
await writeFile('published-report.md', Buffer.from(await response.arrayBuffer()))
```

```python
from pathlib import Path
import httpx
from zoowork import is_run_finished, run_outcome

csv_text = Path("sales.csv").read_text(encoding="utf-8")
task = (
    "Use the CSV below to create /workspace/report.md with a sales table and total. "
    "Read the report back to verify it, then publish it with artifact_publish. "
    f"CSV data follows:\n{csv_text}"
)
session = await client.create_session(agent_id, {
    "initial_events": [{"type": "user.message", "content": task}],
})
async for event in client.stream_events(agent_id, session["session_id"]):
    if is_run_finished(event):
        if run_outcome(event) != "succeeded":
            raise RuntimeError(f"run {run_outcome(event)}")
        break

artifact_id = None
page = 1
while True:
    result = await client.list_artifacts(
        agent_id, session_id=session["session_id"], source_path="/workspace/report.md",
        page=page, limit=50,
    )
    artifact_id = next(
        (item["artifact_id"] for item in result["artifacts"] if item.get("status") == "ready"),
        None,
    )
    if artifact_id is not None or not result["has_more"]:
        break
    page += 1
if artifact_id is None:
    raise RuntimeError("No ready report Artifact")
download = await client.download_artifact(agent_id, artifact_id)
if not download.get("url"):
    raise RuntimeError("No Artifact download URL")
async with httpx.AsyncClient(follow_redirects=True) as http:
    response = await http.get(download["url"])
    response.raise_for_status()
    Path("published-report.md").write_bytes(response.content)
```

A successful run is not proof of publication or correct output. Inspect the ready Artifact
and validate the downloaded file against the task's acceptance criteria. Do not copy the
ZooWork API key into the download request or log the access URL. Artifacts are separately
published copies; downloading one does not inspect the current workspace file. Follow the
language reference for Artifact signatures and `not-supported.md` for attachment boundaries.

## Agent webhook management

All management is under `/service/v1/agents/{agent_id}/webhooks`.

| TypeScript | Python |
|---|---|
| listAgentWebhooks | list_agent_webhooks |
| createAgentWebhook | create_agent_webhook |
| getAgentWebhook | get_agent_webhook |
| updateAgentWebhook | update_agent_webhook |
| deleteAgentWebhook | delete_agent_webhook |
| rotateAgentWebhookSecret | rotate_agent_webhook_secret |
| testAgentWebhook | test_agent_webhook |
| getAgentWebhookEvent | get_agent_webhook_event |
| listAgentWebhookDeliveries | list_agent_webhook_deliveries |
| getAgentWebhookDelivery | get_agent_webhook_delivery |
| redeliverAgentWebhookDelivery | redeliver_agent_webhook_delivery |
| redeliverAgentWebhookDeliveries | redeliver_agent_webhook_deliveries |

```ts
const created = await zc.createAgentWebhook(agentId, {
  url: 'https://receiver.example/webhook',
  event_types: ['run.finished', 'approval.requested'],
}, 'register-hook-v1')
// Store a non-null signing_secret securely; never log it.
const page = await zc.listAgentWebhooks(agentId) // page.webhooks
const receipt = await zc.testAgentWebhook(agentId, created.endpoint.id, 'test-hook-v1')
const deliveries = await zc.listAgentWebhookDeliveries(agentId, created.endpoint.id, {
  eventType: 'webhook.test',
})
```

```python
created = await client.create_agent_webhook(
    agent_id,
    {"url": "https://receiver.example/webhook", "event_types": ["run.finished"]},
    idempotency_key="register-hook-v1",
)
page = await client.list_agent_webhooks(agent_id)  # page["webhooks"]
receipt = await client.test_agent_webhook(
    agent_id, created["endpoint"]["id"], idempotency_key="test-hook-v1",
)
```

Create, rotation, test and redelivery require a stable idempotency key. SDK writes do not retry
automatically. A replay can return signing_secret=null and signing_secret_available=false after
revocation; do not assume every successful response provides usable plaintext. Rotation accepts
revoke_previous_after of 0 or 86400. Endpoint updates and deletion use POST action paths.

A 202 receipt acknowledges queuing, not delivery or business processing. Query delivery list/detail
for attempts and outcome. Delivery filters include status, event type/id, session, run and schedule.
Endpoint list filters are only cursor/limit. Preserve cursor timestamps without parsing them.
Batch redelivery selects dead deliveries and accepts since, event_types and a limit.

## Receiver acceptance

1. Read raw bytes before JSON parsing and enforce the 16 KiB body ceiling.
2. Verify using unwrapWebhook / unwrap_webhook and the signing secret. Configure all active
   secrets during rotation. Signature timestamp tolerance defaults to 300 seconds.
3. Check the parsed event id equals the verified webhook-id header.
4. Atomically persist a deduplicated event and durable work item keyed by webhook-id. Return
   success for an already accepted duplicate. If durable acceptance fails, return 5xx.
5. Acknowledge only after acceptance. A worker performs application side effects and must
   reconcile crash/retry uncertainty independently.
6. Accept unknown event types without unsupported-type failures. Validate event-specific data
   in the worker. Never log secrets, signatures, raw bodies or protected customer payloads.

Known events include run/session/action/schedule lifecycle and schedule configuration changes.
Webhook subscriptions are independent of schedule delivery settings. After run.finished, query
Run Output; after approval/custom-tool requests, read by ID and resolve through the existing
application endpoints. A test event requires no billable Agent turn.
