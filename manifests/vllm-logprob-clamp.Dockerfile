# Cherry-picks vllm-project/vllm PR #48585 (unmerged as of v0.25.1) onto the pinned base image.
#
# WHY: vLLM's OpenAI-compatible completions endpoint does `max(logprob, -9999.0)` to floor
# zero-probability tokens, but under FP8-path quantization (our ModelOptFp8LinearMethod +
# fp8_e4m3 KV cache) logprob can come back None/NaN/±inf instead of a real float. `max()` either
# raises TypeError (None) or silently passes NaN/inf through to json.dumps(..., allow_nan=False),
# which then raises `ValueError: Out of range float values are not JSON compliant: nan` and 400s
# the whole request. Hit in practice via lm-eval-harness's loglikelihood scoring (echo=True,
# logprobs=1) on qwen36-27b-dense — see swap-ui benchmark test run 2026-07-21.
#
# We first worked around this with `--logprobs-mode processed_logprobs`, but that computes the
# full post-sampling probability distribution over the whole vocab on every generated token and
# cost ~3.5x production serving throughput (58.72 -> 16.55 tok/s). This patch fixes the actual
# root cause instead — a 3-line clamp, zero effect on the decode path — so we can run the default
# `raw_logprobs` mode again.
#
# Remove this whole layer (revert VLLM_IMAGE to the upstream tag) once #48585 merges and ships.
ARG BASE_IMAGE=vllm/vllm-openai:v0.25.1-aarch64
FROM ${BASE_IMAGE}

RUN python3 - <<'PATCH'
import re

logprobs_path = "/usr/local/lib/python3.12/dist-packages/vllm/logprobs.py"
with open(logprobs_path) as f:
    src = f.read()
assert "def clamp_logprob" not in src, "clamp_logprob already present — base image changed?"
src = src.replace("import itertools\n", "import itertools\nimport math\n", 1)
src += '''

# Fallback value used by the OpenAI-compatible API for non-finite logprobs
# (None, nan, or +/-inf). Matches the sentinel used in the original vLLM impl.
_LOGPROB_FALLBACK = -9999.0


def clamp_logprob(logprob):
    """Return a finite logprob, clamping non-finite / missing values."""
    if logprob is None or not math.isfinite(logprob):
        return _LOGPROB_FALLBACK
    return max(logprob, _LOGPROB_FALLBACK)
'''
with open(logprobs_path, "w") as f:
    f.write(src)

serving_path = "/usr/local/lib/python3.12/dist-packages/vllm/entrypoints/openai/completion/serving.py"
with open(serving_path) as f:
    src = f.read()
assert "clamp_logprob" not in src, "serving.py already patched — base image changed?"
src = src.replace(
    "from vllm.logprobs import Logprob\n",
    "from vllm.logprobs import Logprob, clamp_logprob\n",
    1,
)
n1 = src.count("token_logprob = max(step_token.logprob, -9999.0)")
n2 = src.count("max(top_lp[1].logprob, -9999.0)")
assert n1 == 1 and n2 == 1, f"expected exactly one match each, got {n1}/{n2} — base image changed?"
src = src.replace(
    "token_logprob = max(step_token.logprob, -9999.0)",
    "token_logprob = clamp_logprob(step_token.logprob)",
    1,
)
src = src.replace(
    "max(top_lp[1].logprob, -9999.0)",
    "clamp_logprob(top_lp[1].logprob)",
    1,
)
with open(serving_path, "w") as f:
    f.write(src)

print("patched logprobs.py and serving.py OK")
PATCH
