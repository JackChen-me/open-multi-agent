# Project Notes

Current showcase project:
- Team expense management platform for small businesses
- Backend written in TypeScript with Express and PostgreSQL
- Background jobs process receipt OCR results and reimbursement approvals

Implementation details worth probing:
- Uses Redis for short-lived deduplication keys on webhook ingestion
- Exposes `/expenses/:id/approve` for manager approval actions
- Runs nightly reconciliation jobs against third-party accounting exports

Known tradeoffs:
- No queue system yet; background work is triggered in-process
- Approval flow is eventually consistent during third-party sync windows
