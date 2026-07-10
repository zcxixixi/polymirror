# Live redeem settlement integration

## Goal

Integrate the upstream on-chain redeem path while preserving the local multi-account preview ledger, audit semantics, and current copy-trading flow.

## Scope

- Add an executor wrapper for `SecureClient.redeemPositions`.
- Add a settlement engine that handles preview settlement and live on-chain redeem before local position clearing.
- Keep audit action `REDEEM` and the existing `cash_ledger` behavior.
- Wire settlement into `runCopyCycle` before risk trade gating so resolved positions can release exposure even when trading is blocked.
- Add focused tests for live failure, live success, preview cash, and config parsing.

## Out of Scope

- Strategy pruning or parameter tuning.
- Replacing local architecture with upstream wholesale.
- Deploying to the running server before local tests pass.
