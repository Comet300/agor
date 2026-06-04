## ADDED Requirements

### Requirement: Chat preference persistence
The persistence layer SHALL store a per-chat language preference, keyed by chat id, with lookup and upsert. A chat may have a preference before it owns any monitor.

#### Scenario: Set and read a chat language
- **WHEN** a chat's language is set to `en`
- **THEN** reading that chat's preference returns `en`, independent of how many monitors the chat has

#### Scenario: Unset preference
- **WHEN** a chat has never set a language
- **THEN** the preference lookup returns undefined, letting the resolver fall back to the Telegram locale / `ro` default
