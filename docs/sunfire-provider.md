# Sunfire's OCI model transport

Sunfire explicitly uses `openai.gpt-oss-120b` through OCI Generative AI's
Chicago on-demand Chat API. Oracle documents this model's reasoning and native
function calling, and no dedicated AI cluster is required. Requests use the
existing server's instance principal; user API keys never enter the production
container. The endpoint is
`https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/20231130/actions/chat`.

Sources: [model capabilities](https://docs.oracle.com/en-us/iaas/Content/generative-ai/openai-gpt-oss-120b.htm),
[regional availability and hosting](https://docs.oracle.com/en-us/iaas/Content/generative-ai/model-endpoint-regions.htm).

## Selection evidence

On October 18, 2026, bounded requests with invented planning prompts verified
GPT-OSS-120B and Llama 4 Maverick inference in the connected account. GPT-OSS
preserved an additional 100 patients as an absolute batch and asked for missing
arrival details; Maverick proposed that incomplete batch without clarification.
GPT-OSS also asked for the unit and interval of a temporary bed reduction.
Command A returned service errors in both probes. Grok 4.7's actual request was
rejected with a zero service limit; it was not silently substituted during a
request. The user then authorized selection of the best accessible model.

These few functional probes establish access and fit for these planning cases,
not a general model benchmark or a security guarantee. An untrusted-result test
caused an incorrect claim that a proposal was applied. The application therefore
grounds action status in its own validated action/receipt state and never treats
model prose as proof that a mutation occurred. Strict tool argument validation,
authorization, and draft revision checks remain outside the model.

The user also authorized a Grok quota-increase attempt. The current OCI Limits
Increase API showed no existing requests. Submission for Chicago's Grok 4.7
limits (10 requests/minute and 50,000 tokens/minute) returned HTTP 403,
`NotAllowed`: the tenancy is not eligible to submit a limit request and must
contact its administrator or Oracle sales. A final readback confirmed no request
was created and both limits remained zero. No dedicated capacity was purchased,
no infrastructure was provisioned, and GPT-OSS remained selected.

## Minimum host permission

The existing host dynamic group has one additional, compartment-scoped statement:

```text
Allow dynamic-group hospital-surge-instance to use generative-ai-chat in compartment hospital-surge-planner where target.model.id = 'openai.gpt-oss-120b'
```

The update used the current policy ETag and preserved its prior statements,
description, and tags. It grants chat inference for this exact named model,
without model-management, patient-data, or infrastructure permissions.

Sources: [chat permissions](https://docs.oracle.com/en-us/iaas/Content/generative-ai/chat-permissions.htm),
[exact model conditions](https://docs.oracle.com/en-us/iaas/Content/generative-ai/limit-model-access.htm).

## Deployment and failure handling

The provider is disabled or unverified by default. Deployment must explicitly set
`SUNFIRE_ENABLED`, `SUNFIRE_OCI_MODEL`, `SUNFIRE_OCI_REGION`,
`SUNFIRE_OCI_COMPARTMENT_ID`, and `SUNFIRE_OCI_ACCESS_STATUS`. A private
`SUNFIRE_OCI_VERIFICATION` JSON record must match the exact model, region,
compartment, authentication method, status, and version, with a timezone-bearing
verification timestamp. A ready record additionally requires a successful native
tool call from the actual production instance principal. Never reuse verification
from a local user key or a different model configuration.

`availability()` checks this record and recent sanitized failures without paid
inference. It reports quota, permission, connectivity, or rate-limit failures
honestly. There is no fallback model and no automatic inference retry. The
orchestrator bounds the number of calls and can return a schema error for a model
to correct within that same budget. An operator can clear cached failures after
fixing access; clearing a failure cannot create an access proof.

`complete()` accepts only bounded text conversations and declared JSON-schema
tools. It expands bounded, acyclic local schema references before OCI submission;
live probes showed this is necessary for the hosted tool renderer to expose the
typed change variants. Original application validators remain authoritative.
It normalizes native OCI tool calls, rejects incomplete responses,
unknown tools, duplicate call IDs, invalid JSON, non-finite numbers, and excessive
arguments. It returns final visible text and safe token counts while discarding
private reasoning. It never executes a tool. SDK connections use fixed regional
endpoints, bounded timeouts, instance signing, and no automatic retry. Forked
workers discard inherited connection/signing and failure-cache state.

Keep detailed account identifiers, private verification records, and raw test
reports outside tracked documentation. Changing models requires explicit operator
configuration, the matching minimum permission, and a new successful host probe.
