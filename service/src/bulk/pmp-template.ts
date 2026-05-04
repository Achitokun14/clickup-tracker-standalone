import type { StatusDef } from "./types";

/**
 * Plan §O — PMP / PMI / PMBOK style "Project Plan" overlay.
 *
 * 19 charter sections (Scope Management → Quality Management Plan)
 * derived verbatim from a real ClickUp template export. Seeded once
 * per Space on first scaffold; idempotent via
 * `task_index["pmp:<key>"]`.
 *
 * The List sits inside its own `📘 Project Plan` Folder and uses a
 * 3-status override (To Do / In Progress / Complete) so it reads as
 * a charter, not a sprint board.
 */

export interface PmpTemplateTask {
	/** Stable suffix for `task_index["pmp:${key}"]`. Never changes once shipped. */
	key: string;
	/** CU task name as it appears in the List. */
	name: string;
	/** Initial status — must be one of `PMP_LIST_STATUSES[*].status`. */
	status: PmpStatus;
	/** Verbatim body from the source template (placeholder lead-in stripped). */
	body: string;
}

export type PmpStatus = "to do" | "in progress" | "complete";

/** Per-List status override applied to the `project_plan` List. */
export const PMP_LIST_STATUSES: StatusDef[] = [
	{ status: "to do", type: "open", color: "#6B7280", orderindex: 0 },
	{ status: "in progress", type: "custom", color: "#FBBF24", orderindex: 1 },
	{ status: "complete", type: "closed", color: "#10B981", orderindex: 2 },
];

/**
 * Source: ClickUp CSV export `90121515701K0teO7Z8.csv` (sample
 * "Example Project Plan" template). Order matches the canonical PMI
 * project-charter flow; status distribution: 4 complete · 6 in progress
 * · 9 to do.
 */
export const PMP_TEMPLATE: PmpTemplateTask[] = [
	{
		key: "scope_management",
		name: "Scope Management",
		status: "complete",
		body: `[Insert the project's scope management plan here] or give a location where it is kept as a reference.

PROJECT SCOPE
See the detailed scope here.`,
	},
	{
		key: "project_assumptions_and_constraints",
		name: "Project Assumptions and Constraints",
		status: "complete",
		body: `[Insert a brief description of any modifications to the project assumptions and/or limitations that were first stated in the project charter.]

PROJECT ASSUMPTIONS AND CONSTRAINTS
List the budget, deadlines, peer-review windows, holidays, and any other firm constraints that bound the plan.

Example:
- Team budget (e.g. 1,950 hours = 6 people × 325 hours)
- Hard delivery deadline
- Internal review deadline
- Holiday calendar`,
	},
	{
		key: "executive_summary",
		name: "Executive Summary of the Project Charter",
		status: "complete",
		body: `[Give an executive summary of the project charter that has been authorized. Mention the approved Project Charter where appropriate. Expand on any Project Charter provisions that call for more information to be included in the plan.]

PROJECT CHARTER:
Describe the goal of the project in 3–5 sentences. Cover the user-facing capability, the platforms involved, and the integration story.

Deliverables include:
- Preliminary Project Plan
- Requirements Specification
- Analysis (object model, dynamic model, UI)
- Architecture Specification
- Component / Object Specification
- Source Code
- Test Plan
- Final Product / Demo`,
	},
	{
		key: "purpose_of_the_project_plan",
		name: "Purpose of the Project Plan",
		status: "complete",
		body: `[Provide the purpose of the project charter.]

INTRODUCTION:
State why this plan exists, who its audience is, and how it will be maintained throughout the project lifecycle.`,
	},
	{
		key: "regulatory_compliance_requirements",
		name: "Regulatory Compliance Requirements",
		status: "in progress",
		body: `[Outline any regulatory compliance required for the project.]`,
	},
	{
		key: "resource_procurement_plan",
		name: "Resource Procurement Plan",
		status: "in progress",
		body: `[Build the plan and schedule on how the staffing needed for the project will be procured.]`,
	},
	{
		key: "material_procurement_plan",
		name: "Material Procurement Plan",
		status: "in progress",
		body: `[Build the plan and schedule on how the materials needed for the project will be procured.]`,
	},
	{
		key: "audit_schedule",
		name: "Audit Schedule",
		status: "in progress",
		body: `[Outline any applicable government-related reviews or audits that are required for the project.]`,
	},
	{
		key: "resource_plan",
		name: "Resource Plan",
		status: "in progress",
		body: `[Insert the work-breakdown structure for the project or give a location where it is kept.]`,
	},
	{
		key: "deployment_plan",
		name: "Deployment Plan",
		status: "in progress",
		body: `[Inform the team members of the backup plans, security measures, and the precise responsibilities of each participant in order to lay out the strategy for ensuring that the project is prepared for release.]`,
	},
	{
		key: "cost_and_budget_plan",
		name: "Cost and Budget Plan",
		status: "to do",
		body: `[Outline the budget plan.]`,
	},
	{
		key: "communication_plan",
		name: "Communication Plan",
		status: "to do",
		body: `[Insert the project's communication matrix or provide a reference to where it is stored.]

You may refer to the sample format below:

COMMUNICATION PLAN

| Stakeholder | Messages | Medium | Frequency | Communicators | Feedback Mechanisms |
|---|---|---|---|---|---|
| _example_ | _example_ | _email_ | _weekly_ | _PM_ | _reply / standup_ |`,
	},
	{
		key: "project_management_plan_approval",
		name: "Project Management Plan Approval",
		status: "to do",
		body: `Secure approval from the Leadership Team.`,
	},
	{
		key: "project_schedule",
		name: "Project Schedule",
		status: "to do",
		body: `[Outline the project timeline and schedule.]`,
	},
	{
		key: "project_dependencies",
		name: "Project Dependencies",
		status: "to do",
		body: `[Insert the schedule / project dependencies, both internal and external.]`,
	},
	{
		key: "risk_log",
		name: "Risk Log",
		status: "to do",
		body: `[Build the log to document all risks associated with the project.]`,
	},
	{
		key: "project_milestones",
		name: "Project Milestones",
		status: "to do",
		body: `List down the milestones for the project with their estimated completion timeframe.

| Milestone | Estimated Completion Timeframe |
|---|---|
| [Insert milestone description] | [Insert completion timeframe] |
| [Add additional rows as necessary] | |`,
	},
	{
		key: "raci_matrix",
		name: "RACI Matrix",
		status: "to do",
		body: `[Determine the RACI matrix of all stakeholders involved.]

| Activity | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| _example_ | | | | |`,
	},
	{
		key: "quality_management_plan",
		name: "Quality Management Plan",
		status: "to do",
		body: `[Outline the quality assurance plan.]`,
	},
];

const OPERATOR_CALLOUT_PREFIX = "> _Operator action: ";
const OPERATOR_CALLOUT_SUFFIX = "_";

/**
 * Render a PMP task body for CU. Header is the project's display name
 * so the section title context is obvious; bracketed `[Insert ...]`
 * placeholders become visually-distinct blockquote callouts so they
 * don't blend into real content.
 *
 * Pure / sync — safe to call from `planSpace`.
 */
export function renderPmpMarkdown(
	task: PmpTemplateTask,
	displayName: string,
): string {
	const cleanName = (displayName ?? "").trim() || "Project";
	const header = `# ${cleanName} — ${task.name}`;

	// Smart-quote / NBSP sanitiser so CU's renderer never chokes.
	const sanitised = task.body
		.replace(/ /g, " ")
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"');

	const out: string[] = [];
	for (const rawLine of sanitised.split("\n")) {
		const trimmed = rawLine.trim();
		// Whole-line placeholder — tolerate an optional trailing period.
		const whole = trimmed.match(/^\[([^\]]+)\]\.?$/);
		if (whole) {
			out.push(
				`${OPERATOR_CALLOUT_PREFIX}${whole[1]}${OPERATOR_CALLOUT_SUFFIX}`,
			);
			continue;
		}
		// Inline `[ ... ]` mid-sentence — pull the placeholder onto its own
		// blockquote line so the surrounding sentence still reads naturally.
		const inline = rawLine.match(/^(.*?)\[([^\]]+)\](.*)$/);
		if (inline) {
			const [, before, inner, after] = inline;
			if (before.trim()) out.push(before.trimEnd());
			out.push(`${OPERATOR_CALLOUT_PREFIX}${inner}${OPERATOR_CALLOUT_SUFFIX}`);
			if (after.trim()) out.push(after.trimStart());
			continue;
		}
		out.push(rawLine);
	}

	return [
		header,
		"",
		...out,
		"",
		"---",
		"_Auto-managed by clickup-tracker (Project Plan template)._",
	].join("\n");
}
