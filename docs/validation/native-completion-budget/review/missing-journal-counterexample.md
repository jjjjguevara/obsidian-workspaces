# Synthetic missing-journal counterexample

This is a **synthetic CLI validation test**, not a native Mac benchmark or performance result.

The independent reviewer constructed twelve internally valid synthetic report references whose declared NDJSON journal paths did not exist. The gate at source `2d5fee013d45ed509c223d70061f59604b994299` returned `status: passed` and `closureAllowed: true`: it checked the report's journal hash syntax but did not load the journal artifact.

[The preserved archive](missing-journal-counterexample.tar.gz) contains the original inputs, manifest and gate output from that review. Original absolute fixture paths are retained. SHA-256: `bc689494bd78ddbd7c4b7ce54cd0afff58cfb8d37ae6fd0d4240cb46a5be35d2`.

The corrected gate requires explicit portable journal path/hash references and validates actual bytes, ordered records and correspondence with the final report. Its negative regression coverage and the independent post-fix result are recorded in the final review. The original counterexample remains unchanged and is never counted toward Mac acceptance.
