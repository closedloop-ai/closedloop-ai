# Database Schema Relationships

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    CORE ENTITIES                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐
│   Organization   │
├──────────────────┤
│ id               │
│ name             │
│ slug (unique)    │
│ settings         │
└────────┬─────────┘
         │
         │ 1:N
         ├─────────────────────────────────────┐
         │                                     │
         ▼                                     ▼
┌──────────────────┐                 ┌──────────────────┐
│      User        │                 │     Project      │
├──────────────────┤                 ├──────────────────┤
│ id               │                 │ id               │
│ organizationId ──┼─────────────────│ organizationId ──┼───┐
│ clerkUserId      │                 │ name             │   │
│ email            │                 │ description      │   │
│ name             │                 │ codebaseSummary  │   │
│ role             │                 │ settings         │   │
│ linearUserId     │                 └────────┬─────────┘   │
│ slackUserId      │                          │             │
│ githubUsername   │                          │ 1:N         │
└──────────────────┘                          │             │
                                              ├─────────────┼────────────────┐
                                              │             │                │
                                              ▼             ▼                ▼
                                    ┌──────────────┐ ┌────────────┐  ┌──────────────┐
                                    │  Workstream  │ │ Repository │  │   Artifact   │
                                    │ (Initiative) │ │            │  │ (Project-    │
                                    ├──────────────┤ ├────────────┤  │  level)      │
                                    │ id           │ │ id         │  └──────────────┘
                                    │ projectId ───┼─│ projectId  │
                                    │ title        │ │ githubId   │
                                    │ type         │ │ owner      │
                                    │ state        │ │ name       │
                                    │ createdById  │ │ fullName   │
                                    │ assignedToId │ │ isPrimary  │
                                    │ hasUIChanges │ └────────────┘
                                    └──────┬───────┘
                                           │
                                           │ 1:N
         ┌─────────────────┬───────────────┼───────────────┬─────────────────┐
         │                 │               │               │                 │
         ▼                 ▼               ▼               ▼                 ▼
┌─────────────────┐ ┌────────────┐ ┌─────────────┐ ┌────────────┐ ┌──────────────────┐
│WorkstreamEvent  │ │  Artifact  │ │  Approval   │ │Conversation│ │    Comment       │
├─────────────────┤ ├────────────┤ ├─────────────┤ ├────────────┤ ├──────────────────┤
│ id              │ │ id         │ │ id          │ │ id         │ │ id               │
│ workstreamId ───┤ │workstreamId│ │ projectId   │ │workstreamId│ │ workstreamId     │
│ type            │ │ projectId  │ │workstreamId │ │ agentType  │ │ authorId         │
│ fromState       │ │ type       │ │ artifactId  │ └─────┬──────┘ │ content          │
│ toState         │ │ title      │ │requiredRole │       │        │ artifactId       │
│ actorId         │ │ fileName   │ │ approverId  │       │ 1:N    └──────────────────┘
│ actorType       │ │ status     │ │ status      │       │
│ data            │ │ content    │ │ feedback    │       ▼
└─────────────────┘ │ version    │ └─────────────┘ ┌────────────┐
                    │ isLatest   │                 │  Message   │
                    │ parentId   │                 ├────────────┤
                    └─────┬──────┘                 │ id         │
                          │                       │conversation│
                          │ 1:N                   │   Id       │
                          ▼                       │ role       │
                    ┌────────────┐                │ content    │
                    │ FileUpload │                │ tokenUsage │
                    ├────────────┤                └────────────┘
                    │ id         │
                    │ artifactId │
                    │ type       │
                    │ bucket/key │
                    │ filename   │
                    └────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              INTEGRATION ENTITIES                                        │
│                         (All linked to Organization 1:1)                                 │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────┐     ┌────────────────────┐     ┌────────────────────┐
│ LinearIntegration  │     │ GitHubInstallation │     │  SlackIntegration  │
├────────────────────┤     ├────────────────────┤     ├────────────────────┤
│ organizationId (1:1)     │ organizationId (1:1)     │ organizationId (1:1)
│ accessToken        │     │ installationId     │     │ accessToken        │
│ linearOrgId        │     │ accountLogin       │     │ botUserId          │
│ defaultTeamId      │     │ accountType        │     │ teamId/teamName    │
│ webhookId/Secret   │     └────────────────────┘     │ defaultChannelId   │
└────────────────────┘                                └────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                      WORKSTREAM-LINKED INTEGRATION ENTITIES                              │
└─────────────────────────────────────────────────────────────────────────────────────────┘

         Workstream
              │
              │ 1:1 or 1:N
    ┌─────────┼─────────┬──────────────────┬──────────────────┐
    │         │         │                  │                  │
    ▼         ▼         ▼                  ▼                  ▼
┌─────────┐ ┌─────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Linear  │ │ Linear  │ │   GitHub     │ │   GitHub     │ │   GitHub     │
│ Issue   │ │ Subtask │ │ PullRequest  │ │  ActionRun   │ │  ActionRun   │
│ (1:1)   │ │ (1:N)   │ │    (1:N)     │ │    (1:N)     │ │    (1:N)     │
├─────────┤ ├─────────┤ ├──────────────┤ ├──────────────┤ └──────────────┘
│linearId │ │linearId │ │ repositoryId │ │ repositoryId │
│linearKey│ │linearKey│ │ githubId     │ │ runId        │
│linearUrl│ │ title   │ │ number       │ │ workflowName │
│ teamId  │ │isComplete│ │ headBranch   │ │ status       │
│syncStatus│ └─────────┘ │ state        │ │ conclusion   │
└─────────┘              │ mergedAt     │ └──────────────┘
                         └──────────────┘
```

## Key Relationships Summary

| Parent | Child | Cardinality |
|--------|-------|-------------|
| Organization | User | 1:N |
| Organization | Project | 1:N |
| Organization | LinearIntegration | 1:1 |
| Organization | GitHubInstallation | 1:1 |
| Organization | SlackIntegration | 1:1 |
| Project | Workstream | 1:N |
| Project | Repository | 1:N |
| Project | Artifact | 1:N |
| Workstream | Artifact | 1:N |
| Workstream | WorkstreamEvent | 1:N |
| Workstream | Approval | 1:N |
| Workstream | Conversation | 1:N |
| Workstream | Comment | 1:N |
| Workstream | LinearIssue | 1:1 |
| Workstream | LinearSubtask | 1:N |
| Workstream | GitHubPullRequest | 1:N |
| Workstream | GitHubActionRun | 1:N |
| Conversation | Message | 1:N |
| Artifact | FileUpload | 1:N |
