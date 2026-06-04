## ADDED Requirements

### Requirement: One-tap seller contact
The system SHALL generate a "Call Seller" quick action that produces a `tel:` deep link from the listing's parsed phone property.

#### Scenario: Call link generated
- **WHEN** an alert card with a parsed phone number is rendered and the user taps "Call Seller"
- **THEN** the system provides a `tel:` deep link to that number

#### Scenario: No phone available
- **WHEN** a listing has no parsed phone property
- **THEN** the system omits or disables the "Call Seller" action

### Requirement: Negotiation offer draft
The system SHALL generate a "Draft Offer Message" action that anchors at 10% below the listing price, rounded to the nearest 5 (AnchorPrice = RoundToNearest5(Price × 0.90)), and emits a localized template inside markdown backticks for copy-paste.

#### Scenario: Anchor computed and templated
- **WHEN** a user taps "Draft Offer Message" on a listing priced 1000
- **THEN** the system computes an anchor of 900 (rounded to nearest 5) and outputs a localized offer message wrapped in markdown backticks

#### Scenario: Rounding to nearest 5
- **WHEN** the raw 90% anchor is 887
- **THEN** the system rounds it to 885 before inserting it into the template
