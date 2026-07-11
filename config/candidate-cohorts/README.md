# Candidate cohort seeds

`quality12-20260711-v1.json` is a deterministic, watchlist-only seed. It always
generates twelve isolated 200U preview accounts for ec47, dance,
LinaBell, and pada, but every seed Candidate has `freshIntakePassed: false`.
The accounts remain visible while copy trading and their leaders stay disabled.

Do not turn the tracked seed into a deployment approval. Before a maintenance
switch, copy it to a separate operational input, run a current Candidate intake,
archive that evidence, and only then set approved Candidates to
`freshIntakePassed: true` with the evidence file's lowercase SHA-256 in
`freshIntakeEvidenceSha256`. Schema validation rejects implicit approval,
approval without a hash, and approval evidence attached to a watchlist-only
Candidate.
