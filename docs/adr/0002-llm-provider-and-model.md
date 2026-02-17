
---
doc_type: adr
date: 20260216
owner: you
status: proposed  # proposed | accepted | deprecated | superseded
slug: llm-provider-and-model
---

# ADR: LLM Provider and Model Selection — OpenAI GPT-4o-mini

## Context and Problem Statement
Every captured thought must be classified into one of three categories (`action_required`, `reference`, `noise`) within 30 seconds. The LLM must achieve >=85% accuracy on short, partially-formed staff-engineer thoughts. Cost must stay under $0.50/user/month ($50/month for 100 users). The PRD specifies "GPT-4-class model via OpenAI API (or equivalent DPA-capable provider)."

The system runs on Cloudflare Workers (see ADR-0003). Classification is performed asynchronously via Cloudflare Queues, so outbound API latency does not block webhook handling. The Workers runtime supports `fetch` natively and is compatible with the OpenAI Node.js SDK.

## Decision Drivers
- Must achieve >=85% classification accuracy on coarse 3-bin classification of staff-engineer thoughts
- LLM cost must stay under $0.50/user/month ($50/month for 100 users) per PRD AC10
- Classification latency must stay under 30 seconds P95
- Must be compatible with Cloudflare Workers runtime (SDK uses `fetch`)
- Upgrade/downgrade path must be low-friction (config change, not architecture change)

## Considered Options
- **Option A: OpenAI GPT-4o**
  - Pros: Highest accuracy expected. Well-tested. DPA available for enterprise.
  - Cons: Higher cost (~$0.10/user/month based on PRD estimate, but with less headroom for prompt iteration and retries). 

- **Option B: OpenAI GPT-4o-mini**
  - Pros: Significantly cheaper (~10x less than GPT-4o). Faster response times (lower latency helps meet 30s P95). Accuracy on coarse 3-bin classification is expected to be comparable to GPT-4o — this is a simple classification task, not creative generation. Same API, same DPA eligibility. Cost estimate: ~$0.01-0.02/user/month, leaving massive headroom.
  - Cons: Slightly lower reasoning capability on edge cases. May need more careful prompt engineering.

- **Option C: Anthropic Claude 3.5 Haiku**
  - Pros: Competitive pricing and performance. Good at following structured output formats.
  - Cons: Different API contract — adds integration complexity. Smaller ecosystem of tooling. No clear accuracy advantage for this task.

- **Option D: Self-hosted open-source model (e.g., Llama 3)**
  - Pros: No data leaves infrastructure. No per-call cost after infra investment.
  - Cons: Massive ops burden for a solo operator. GPU hosting costs far exceed API costs at beta scale. Accuracy unproven for this task. Completely disproportionate to the 100-user beta.

- **Option E: Cloudflare Workers AI**
  - Pros: No external API call — models run on Cloudflare's edge via Workers AI binding (`env.AI`). Data stays within Cloudflare infrastructure. No separate API key management. Built-in to the Workers platform.
  - Cons: Available model quality for structured classification tasks is unclear — the models are primarily open-source (Llama, Mistral variants) and may not match GPT-4o-mini accuracy on nuanced staff-engineer thoughts. Limited model selection compared to OpenAI's catalog. Less proven for production classification workloads. Prompt engineering ecosystem is less mature. If accuracy doesn't meet the >=85% threshold, switching to OpenAI mid-beta requires an architecture change.

## Decision Outcome
Chosen option: **Option B — OpenAI GPT-4o-mini**, because:

1. **Cost is 10x lower** than GPT-4o, keeping total LLM spend at ~$1-2/month for 100 users — well under the $50 budget with room for retries and prompt iteration.
2. **Accuracy is expected to be sufficient** for coarse 3-bin classification. The Week 0 validation experiment will confirm this. If accuracy is below threshold, we can upgrade to GPT-4o with a single model parameter change (same API, same provider).
3. **Latency is lower** than GPT-4o, making the 30-second P95 classification target easier to hit.
4. **Same API and provider** as the fallback option (GPT-4o), so upgrading is a config change, not an architecture change.
5. **Workers AI was not chosen** because GPT-4o-mini is proven for classification tasks and the cost difference is negligible at beta scale (~$2/month). The risk of insufficient accuracy with Workers AI models outweighs the benefit of keeping everything on-platform. Workers AI remains a future option if we want to eliminate the OpenAI dependency.
6. **Fallback strategy**: If GPT-4o-mini accuracy is 80-85% in Week 0 validation, upgrade to GPT-4o. If GPT-4o accuracy is also <85%, the project does not proceed (per PRD de-risk gate).

### Consequences
- Good, because LLM costs are negligible (~$2/month), leaving 96% of the $50 budget as headroom.
- Good, because lower latency improves user experience on classification speed.
- Good, because upgrading to GPT-4o is a single config change if accuracy is insufficient.
- Good, because the OpenAI SDK works natively in the Workers runtime via `fetch`.
- Bad, because we're dependent on OpenAI as a single provider (mitigated by the fact that the classification interface is a simple prompt-in/label-out contract that can be swapped to any provider, including Workers AI).
- Bad, because accuracy must be validated in Week 0 before committing (this is a feature, not a bug — it's the PRD's de-risk gate).
- Bad, because outbound API calls to OpenAI add latency vs. Workers AI (mitigated by async classification via Cloudflare Queues — latency doesn't block the user's DM ack).

### Confirmation
- **Week 0 validation:** Run classification prompt against 50 sample staff-engineer thoughts. Measure accuracy. If >=85%, proceed with GPT-4o-mini. If 80-85%, upgrade to GPT-4o (single config change). If <80% on GPT-4o, project does not proceed.
- **Post-launch metric:** Override rate (overrides / total_classifications over trailing 7-day window) stays <15%. If 15-20%, tune prompt. If >20%, pause rollout.
- **Cost monitoring:** Weekly check of OpenAI API usage dashboard. Monthly LLM cost stays under $50 (PRD AC10).
