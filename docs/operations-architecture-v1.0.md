# Operations Architecture v1.0

## 1. Draw Operations

Authorized monitoring roles:

- Super Admin
- Operations Admin
- Settlement Admin
- Risk Admin

Missed draw rules:

- Single missed draw: create alert and continue operations.
- Multiple consecutive missed draws, or configured missed-draw threshold: stop draw generation and require operator review.

Result delay thresholds:

- Rapid Draw: alert if result or settlement exceeds 5 seconds.
- Hot Spot: alert if result is not available within 1 minute.

Player experience:

- Display `Delayed` when result or settlement processing exceeds configured thresholds.

Void conditions:

- corrupted result
- incomplete result
- unverifiable result
- unusable result data

Internal RNG:

- automatic result generation
- drawing-linked result records
- full auditability
- full traceability

## 2. Result Operations

Feed failure:

- Authorized operator may manually enter official result.

Manual result entry:

- Permission-based operator function.

Audit requirements:

Record:

- user
- timestamp
- drawing
- game
- entered result
- reason
- source notes
- feed status

Manual entry matching official result:

- log match
- create audit record
- no further action

Official result correction:

- System creates correction request.
- Operator decides approve or reject.
- No automatic resettlement.

Player display:

- Result Pending

## 3. Settlement Operations

Settlement trigger:

Result Posted -> Automatic Settlement.

Partial settlement:

- Mark as `PARTIALLY_COMPLETED`.
- Alert operators.

Identify:

- affected tickets
- affected ticket lines
- affected players
- affected hierarchy accounts

Settlement retry:

- Permission-based.

Settlement SLA:

- Rapid Draw: 5 seconds.
- Hot Spot: 1 minute.

Settlement alerts notify:

- Super Admin
- Operations Admin
- Settlement Admin
- Risk Admin

Reconciliation requirements:

- expected tickets
- processed tickets
- expected ticket lines
- processed ticket lines
- expected payout
- actual payout

Settlement protection mode:

After 3 consecutive settlement failures:

- disable wagering
- create critical alert
- require operator review

## 4. Accounting Operations

Weekly close:

- Automatic scheduled job.
- May also be manually initiated by Super Admin, Operations Admin, Settlement Admin, or Risk Admin.

Weekly close approval:

- none

Commission run:

- automatically after weekly close

Adjustments:

- Credit Adjustment
- Debit Adjustment

Approval:

- configurable approval threshold

Negative balances:

- allowed
- optional configurable alerts

Commission disputes:

Operators may:

- recalculate commission
- create commission adjustment
- perform manual commission adjustment

Closed periods:

- never reopen

Exception:

- emergency Super Admin procedure

## 5. Wallet Operations

Wallet types:

- cash
- credit
- freeplay

Single account:

- multiple wallets

Funding source required:

- cash
- credit
- freeplay

Settlement must preserve originating wallet type.

## 6. Cashier Operations

Deposits:

Approved cashier callback -> automatic cash wallet credit.

Withdrawals:

Player Request -> approval required -> payment sent.

All withdrawals require approval.

Failed withdrawals:

- operator review required

Manual reconciliation:

- supported

Cashier permissions:

- permission-based

Future:

- Cashier Adapter Layer
- Support multiple providers

## 7. Customer Support Operations

Support may:

- view balances
- view tickets
- create dispute cases
- escalate disputes

Permission-based:

- adjustments
- ticket voids
- audit visibility
- account freeze
- PII access

Support may not:

- modify settlements
- modify results
- resettle
- alter financial outcomes directly

Account closure:

- not allowed

## 8. Risk & Fraud Operations

Large payout alerts:

Configurable thresholds:

- single payout
- daily payout
- weekly payout

Risk detection:

- sudden stake increase
- repeated max bets
- correlated betting patterns
- abnormal wagering volume

Late betting alone is not a risk trigger.

Freeze authority:

- permission-based

Freeze effects:

- block wagering
- block deposits
- block withdrawals

Risk review queue:

- automatic creation

Withdrawal holds:

- risk flags may block withdrawals

Future detection:

- IP correlation
- device correlation
- login patterns
- betting timing correlation
- payment correlation
- hierarchy correlation

Risk clearance:

- permission-based

## 9. Monitoring & Alert Operations

Operations dashboard:

- draw status
- settlement status
- worker status
- cashier status
- integrity status
- risk alerts

Alert channels:

- in-app
- email
- SMS
- Telegram

Future:

- Slack
- Teams
- workplace integrations

Alert lifecycle:

Created -> Acknowledged -> Resolved.

Alert audit:

- who acknowledged
- who resolved
- timestamps
- notes

Escalation:

- 5 minutes: escalate to Super Admin.
- 15 minutes: emergency notifications.

Alert severity:

- INFO
- WARNING
- CRITICAL
- EMERGENCY

## 10. Operational Protection Modes

Protection modes:

- Missed Draw Protection
- Settlement Protection
- Cashier Protection
- Integrity Protection

Protection actions:

- disable wagering
- pause withdrawals
- generate critical alerts
- require operator review

## 11. Administrative User Operations

User creation:

- Super Admin
- Operations Admin

Role assignment:

- permission-based

High-risk permissions:

Super Admin only:

- settlement.resettle
- result.correct
- override.approve

User deactivation:

- Super Admin
- Operations Admin
- Risk Admin

User deletion:

- never

Use:

- disabled
- archived

Break-glass accounts:

- 2 accounts

Session policy:

- single active session

Administrative controls:

- terminate sessions
- force password reset
- require MFA re-enrollment

Session audit:

- login
- logout
- IP
- device
- browser
- approximate location

Dormant accounts:

90 days inactive:

- disable pending review

## 12. Governance Principles

Platform Governance Separation.

Hierarchy participants:

- player
- agent
- master agent

Platform operators:

- super admin
- operations admin
- settlement admin
- risk admin
- compliance admin

Hierarchy participants may never receive:

- settlement.execute
- settlement.resettle
- result.correct
- override.approve
- integrity.verify
- audit.review
- rng.configure
- market.configure
- commission.recalculate

## 13. Open Operational Questions

Future decisions:

- cashier providers
- external feeds
- notification providers
- hosting provider
- multi-region strategy
- advanced fraud detection
- regulatory requirements
