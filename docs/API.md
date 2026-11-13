# API

## Navigation

- [Architecture](Architecture.md)
- [Database](Database.md)
- [Deployment](Deployment.md)
- [Scraper System](Scraper-System.md)

## Base Path

All backend routes are mounted under `/api/v1`.

## Response Shape

The frontend service layer expects a standard envelope with:

| Field | Meaning |
| --- | --- |
| `statusCode` | HTTP-style status returned by the API wrapper |
| `data` | Payload for the request |
| `message` | Human-readable status message |
| `success` | Boolean success indicator |

## Authentication

Protected routes require a valid JWT and use the existing authentication middleware on the backend.

## Hackathons

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/hackathons` | List hackathons |
| `GET` | `/hackathons/:id` | Fetch a single hackathon by ID |

## Users

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/users/register` | Register a new user |
| `POST` | `/users/login` | Sign in |
| `POST` | `/users/auth/github` | GitHub authentication callback |
| `POST` | `/users/logout` | Sign out |
| `POST` | `/users/refresh` | Refresh access token |
| `GET` | `/users/me` | Fetch the authenticated user |
| `GET` | `/users/search` | Search users |
| `POST` | `/users/change-password` | Update password |
| `PUT` | `/users/update` | Update account details |
| `POST` | `/users/saved/:hackathonId` | Toggle a saved hackathon |
| `GET` | `/users/saved` | List saved hackathons |
| `POST` | `/users/applications` | Add a user-level application record |
| `PUT` | `/users/applications/:applicationId` | Update an application record |
| `DELETE` | `/users/applications/:applicationId` | Remove an application record |
| `GET` | `/users/applications` | List user applications |
| `GET` | `/users/pending-reflections` | List pending reflections for the user |

## Teams

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/teams/invitations/accept` | Accept an invitation link |
| `GET` | `/teams/invitations/preview` | Preview an invitation before accepting |
| `POST` | `/teams/join` | Join a team by code |
| `GET` | `/teams/user/invitations` | List invitations for the current user |
| `POST` | `/teams/user/invitations/:invitationId/respond` | Respond to an invitation |
| `POST` | `/teams` | Create a team |
| `GET` | `/teams` | List the current user’s teams |
| `GET` | `/teams/:id` | Get a team by ID |
| `PUT` | `/teams/:id` | Update a team |
| `DELETE` | `/teams/:id` | Delete a team |
| `POST` | `/teams/:id/regenerate-code` | Regenerate the team join code |
| `POST` | `/teams/:id/invitations/user` | Invite a user by username or ID |
| `GET` | `/teams/:id/invites` | List legacy invitations |
| `POST` | `/teams/:id/generate-invite-link` | Generate an invitation link |
| `POST` | `/teams/:id/members` | Add team members |
| `DELETE` | `/teams/:id/members/:userId` | Remove a team member |
| `POST` | `/teams/:id/hackathons` | Link a team to a hackathon |
| `GET` | `/teams/:id/hackathons` | List team hackathon participations |
| `DELETE` | `/teams/:id/hackathons/:hackathonId` | Unlink a hackathon from a team |
| `PATCH` | `/teams/:id/hackathons/:thId/status` | Update participation status |
| `POST` | `/teams/:id/hackathons/:thId/stages` | Add a stage |
| `PUT` | `/teams/:id/hackathons/:thId/stages/:stageId` | Update a stage |
| `DELETE` | `/teams/:id/hackathons/:thId/stages/:stageId` | Delete a stage |
| `POST` | `/teams/:id/hackathons/:thId/stages/:stageId/reflections` | Add a reflection |
| `DELETE` | `/teams/:id/hackathons/:thId/stages/:stageId/reflections` | Remove a reflection |

## Scrapers

All scraper orchestration endpoints below are protected: requests must carry
the `x-cron-secret` header matching the configured cron secret. A missing or
wrong secret returns `401`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/scrape/devfolio_scrape` | Run the Devfolio scraper |
| `GET` | `/scrape/unstop_scrape` | Run the Unstop scraper |
| `GET` | `/scrape/devpost_scrape` | Run the Devpost scraper |
| `GET` | `/scrape/mlh_scrape` | Run the MLH scraper |
| `GET` | `/scrape/hack2skill_scrape` | Run the Hack2Skill scraper |
| `POST` | `/scrape/refresh` | Run all five scrapers synchronously and return the run summary (HTTP 200 even when some platforms failed) |
| `POST` | `/scrape/cron/trigger` | Accept immediately (`200`) and run the scrapers in the background; returns the run id; duplicate triggers while a run is active return "already running" without starting a second run |
| `GET` | `/scrape/runs/latest` | Status and summary of the most recent run |
| `GET` | `/scrape/runs/:runId` | Status and summary of a specific run; unknown ids return `404` |

### Run summary shape

Every run (synchronous refresh or background trigger) is registered with a
unique `runId` and produces the same auditable summary:

| Field | Meaning |
| --- | --- |
| `runId` | Unique identifier of this run, used by the status endpoints |
| `status` | `running` or `completed` |
| `startedAt` / `finishedAt` | ISO timestamps; `finishedAt` is `null` while running |
| `total` | Number of platforms attempted (always 5) |
| `successful` / `failed` | Platform counts |
| `cacheInvalidated` | `true` only when at least one platform succeeded; an all-failed run never clears the cache |
| `results` | Per-platform entries in fixed order (Devfolio, Unstop, Devpost, MLH, Hack2Skill), each with `name`, `status` (`success`/`failed`) and `error` when failed |

All five platforms are always attempted; a single platform throwing an error
never interrupts the others.

## Notes for Contributors

- Keep new endpoints aligned with the existing route groups.
- Prefer reusing the current API envelope and auth model.
- Add documentation here whenever a route is introduced or removed.
