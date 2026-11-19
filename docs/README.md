# Documentation

Reference for how the project is built and how to change it. The [top-level README](../README.md) covers what the project is, its recorded results, and its limits; these pages cover the mechanics and stay valid across runs (they quote code constants by name, not the output of a particular run).

| Page | Covers |
| --- | --- |
| [Architecture](architecture.md) | Components, the end-to-end run, where every file goes, the hidden-truth boundary |
| [minicloud](minicloud.md) | The local AWS-style emulator: stack templates, events, retries, schedules, logs, CLI |
| [ETL](etl.md) | Validate, Load and Aggregate: rules, idempotency, the statistical method |
| [Data reference](data-reference.md) | SQL schema, static game data snapshots, raw match records, published JSON |
| [Simulator](simulator.md) | Lobby simulation, the hidden meta, patch changes, dirty data, the truth check |
| [Combat simulator](combat-sim.md) | The browser fight engine: rules, spells, traits, items, `check:sim` |
| [Development](development.md) | Setup, tests, CI/deploy, and recipes for common changes |

When code and these pages disagree, the code wins; please fix the page in the same change.
