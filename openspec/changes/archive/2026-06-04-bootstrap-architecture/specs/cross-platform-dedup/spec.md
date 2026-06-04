## ADDED Requirements

### Requirement: Composite signature hashing
The system SHALL construct a composite signature hash for each item as a function of its normalized title, rounded price, and approximate location: Hash = f(NormalizedTitle, RoundedPrice, ApproximateLocation).

#### Scenario: Hash generated per item
- **WHEN** a new item enters the deduplication stage
- **THEN** the system computes its composite signature hash from normalized title, rounded price, and approximate location

### Requirement: 24-hour cross-platform collapse
The system SHALL, when an item's hash matches an existing listing discovered within the same 24-hour evaluation buffer, intercept the duplicate notification and append the alternative vendor link into the existing active UI block instead of sending a new alert.

#### Scenario: Duplicate cross-post detected
- **WHEN** an incoming item's hash matches a listing already alerted within the last 24 hours
- **THEN** the system suppresses the new notification and appends the alternative source link to the original alert block

#### Scenario: No match within buffer
- **WHEN** an item's hash matches nothing within the 24-hour buffer
- **THEN** the system treats it as a distinct listing and allows its notification to proceed
