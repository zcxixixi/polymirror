# Candidate cohort seeds

`quality6-20260711-v1.json` is the current deterministic, watchlist-only seed. It
generates six isolated 200U preview accounts for b55 and dance, but every seed
Candidate has `freshIntakePassed: false`. The older quality12 seed remains only
as historical watchlist input and is not accepted by the shadow deploy gate.
The accounts remain visible while copy trading and their leaders stay disabled.

Do not turn the tracked seed into a deployment approval. Before a maintenance
switch, copy it to a separate operational input, run a current Candidate intake,
archive that evidence, and only then set approved Candidates to
`freshIntakePassed: true` with the evidence file's lowercase SHA-256 in
`freshIntakeEvidenceSha256`. Schema validation rejects implicit approval,
approval without a hash, and approval evidence attached to a watchlist-only
Candidate.
