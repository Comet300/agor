# plugin-registry Specification

## Purpose
TBD - created by archiving change bootstrap-architecture. Update Purpose after archive.
## Requirements
### Requirement: Manifest loading at boot
The plugin registry SHALL parse and provision all `.yaml` vendor specifications at boot time, building a domain-to-plugin map for O(1) lookup at request time.

#### Scenario: Manifests provisioned on startup
- **WHEN** the system boots
- **THEN** the registry loads every vendor manifest and registers its `domain` for matching

### Requirement: Manifest validation against IVendorPlugin
The plugin registry SHALL validate each manifest against the `IVendorPlugin` contract and reject malformed manifests with a fail-fast error.

#### Scenario: Valid manifest accepted
- **WHEN** a manifest declares `vendor`, `domain`, `engine`, `rate_limit_ms`, `search_mapping`, and `product_mapping`
- **THEN** the registry registers it as an active plugin

#### Scenario: Malformed manifest rejected
- **WHEN** a manifest is missing a required field or has an invalid `engine` value
- **THEN** the registry rejects it at boot and reports which manifest failed

### Requirement: Extraction map linkage
The plugin registry SHALL link execution tasks to the structural extraction maps (`payload_locator`, `json_path`, `fields`) defined by the matched plugin.

#### Scenario: Task linked to extraction map
- **WHEN** the orchestrator resolves a URL to a vendor
- **THEN** the registry returns that vendor's search and product extraction maps for use by the scraping engine

