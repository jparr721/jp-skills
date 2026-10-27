"""Offline documentation contracts, not proof of agent or tracker enforcement."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / 'skills/filing-agent-tasks'


class FilingAgentTasksSkillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.content = (SKILL / 'SKILL.md').read_text()
        _, cls.frontmatter, cls.body = cls.content.split('---', 2)
        cls.template = (SKILL / 'templates/task.md').read_text()

    def assert_contains_all(self, text, phrases):
        for phrase in phrases:
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, text)

    def test_frontmatter_and_portability(self):
        self.assertTrue(self.content.startswith('---\n'))
        self.assert_contains_all(self.frontmatter, (
            '\nname: filing-agent-tasks\n', 'version: 0.1.0',
            'author: Jarred Parr (jparr721), Hermes Agent',
            'license: MIT', 'platforms: [linux, macos, windows]',
        ))
        description = next(line.removeprefix('description: ') for line in
                           self.frontmatter.splitlines() if line.startswith('description: '))
        self.assertLessEqual(len(description), 60)
        self.assertTrue(description.endswith('.'))
        for text in (self.content, self.template):
            self.assertNotIn('/Users/', text)
            self.assertNotIn('/home/', text)

    def test_repo_integration_and_local_template_link(self):
        self.assert_contains_all(self.body, (
            '## Herdr preflight', '## When to Use', '## Prerequisites',
            '## Procedure', '## Readiness gate', '## Pitfalls',
            '## Verification and handoff', '## Framework tail',
            '../cleanup/SKILL.md', 'templates/task.md',
            '/filing-agent-tasks', '/skill:filing-agent-tasks',
        ))
        self.assertTrue((SKILL / '../cleanup/SKILL.md').is_file())
        self.assertEqual((ROOT / 'README.md').read_text().count(
            '[`filing-agent-tasks`](skills/filing-agent-tasks/SKILL.md)'), 1)
        self.assertEqual(len(re.findall(r'^\d+\. \*\*', self.body, re.M)), 7)

    def test_full_intake_and_batch_accounting(self):
        self.assert_contains_all(self.body, (
            'paginated comments', 'Search for duplicates',
            'Preserve exact identifiers', 'validate malformed IDs',
            'every requested deliverable', 'per-item ledger',
            'requested versus processed IDs programmatically',
            'every requested item and verified counts by verdict',
        ))

    def test_research_requires_actual_sources_and_honest_claims(self):
        self.assert_contains_all(self.body, (
            '`search_files`', '`read_file`', 'definitions, callers',
            'tests and CI', 'across service/repo boundaries',
            'suspected cause from a demonstrated one',
            'revision-qualified `path:line`',
            'every material factual claim has evidence',
            'Commands must come from inspected repo recipes',
            'unexecuted commands honestly', 'read-only by default',
        ))

    def test_question_closure_not_template_population(self):
        self.assert_contains_all(self.body, (
            'A populated template is not evidence of readiness',
            '`resolved`, `blocking`, or `non-blocking`',
            'Resolve retrievable questions yourself',
            'never invent product behavior, access, numeric targets or approval',
            'Batch remaining independent questions',
            'Persist answers into the canonical task',
            'every execution-blocking question is answered or visibly blocks readiness',
            'who owns the follow-up',
        ))

    def test_scope_and_verifiable_acceptance(self):
        self.assert_contains_all(self.body, (
            'specific in/out scope', 'criterion-to-verification map',
            'every requirement maps to acceptance and proof',
            'For docs/research/ops', 'not applicable — <reason>',
            'Implementation hints are not acceptance criteria',
        ))
        self.assert_contains_all(self.template, (
            'Criterion | Preconditions / action | Expected observable result',
            'Verification command or independent check | Evidence to capture',
            'negative/regression case', 'Verification environment/data',
            'Command status', 'Completion proof',
        ))

    def test_dependencies_and_research_spikes_cannot_fake_readiness(self):
        self.assert_contains_all(self.body, (
            'Each child needs its own complete contract',
            'dependency IDs, direction, the exact output consumed',
            'Dependencies must be satisfied before execution readiness',
            'A research spike may be ready',
            'implementation task stays blocked',
            'no circular ordering, orphan deliverable or hidden prerequisite',
        ))

    def test_cold_start_review_has_a_concrete_ambiguity_challenge(self):
        self.assert_contains_all(self.body, (
            'only the ticket, its cited sources and normal repo access',
            'two plausible incompatible implementations',
            'independent read-only reviewer', 'without hidden chat context',
            'concrete unanswered questions, not award a completeness score',
            'perform the same adversarial pass yourself',
            'every review finding is resolved',
        ))

    def test_external_writes_require_conflict_safety_and_readback(self):
        self.assert_contains_all(self.body, (
            'Re-fetch the target before updating', 'revision/conflict protection',
            'serialized/exclusive editing', 'lost-update race',
            'stop the replacement', 'readback cannot prove a concurrent edit was preserved',
            'preserve unrelated edits', 'never overwrite an entire ticket from a stale snapshot',
            'Re-fetch the exact saved task',
            're-run the readiness gate below against the stored result',
            'actual workflow state, not just the write response',
            'read that state back too', 'saving/verification failed',
        ))

    def test_gate_separates_ready_blocked_and_unsaved(self):
        self.assert_contains_all(self.body, (
            '**READY**', '**NEEDS_INPUT**', '**BLOCKED**', '**DRAFT**',
            'zero unresolved execution-blocking questions',
            'required decisions/access/prerequisites satisfied',
            'readiness to implement, not proof implementation is complete',
            'Multiple blocker categories may coexist',
            'successful write without readback cannot be READY',
            'it is not filed', 'reopen affected questions and rerun the gate',
            'not permission to manufacture answers',
        ))

    def test_authority_boundaries_are_explicit(self):
        self.assert_contains_all(self.body, (
            'use Composio for Linear, never direct Linear MCP',
            'not permission to switch providers',
            'Never read credential files',
            'does not implement it or authorize deployment',
            'Never invent labels/statuses, auto-assign people, change priority',
            'dispatch implementation implicitly',
            "Do not regress an in-progress/completed ticket's workflow state",
            'route questions through the designated manager',
        ))

    def test_blocked_work_is_durable_before_pausing(self):
        self.assert_contains_all(self.body, (
            'Before pausing for answers, save the researched draft and question ledger',
            'not-ready verdict', 'even to partial updates',
            'Do not pause with the only record in chat',
            'On resumption, read the current task and answers',
            'do not treat a proposed recommendation as approval',
        ))

    def test_portable_preflight_and_enforcement_limitations(self):
        self.assert_contains_all(self.body, (
            "host's native environment mechanism", 'not a runtime guard',
            'tracker hook or automatic follow-up scheduler',
            'not agent compliance',
        ))
        self.assertNotIn('${HERDR_ENV:-}', self.body)

    def test_template_contains_the_execution_contract(self):
        self.assert_contains_all(self.template, (
            '## Outcome and context', '## Scope and boundaries',
            '## Research and starting points', '## Behavior and risk decisions',
            '## Question and decision ledger', '## Dependencies and execution order',
            '## Acceptance and proof map', '## Readiness review',
            'Permissions and security', 'Data and compatibility', 'Operational risk',
            'Unblock condition', 'non-blocking rationale and follow-up owner',
            'relevant negative/regression case', 'Revalidation triggers',
            'READY is not permitted until that check succeeds',
        ))


if __name__ == '__main__':
    unittest.main()
