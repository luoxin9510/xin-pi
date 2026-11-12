// Agent teams: the four task-list tools (spec .scratch/agent-teams/01-agent-teams.md, "Tasks"): `TaskCreate`, `TaskGet`,
// `TaskList`, `TaskUpdate`. The lead and every teammate get them; each builds a TaskEnv for its own process and the work is
// team-tasks.ts's.

import { type Static, Type } from "typebox";
import { type JsonValue, StringEnum } from "xpi-ai";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import {
	createTask,
	getTask,
	listTasks,
	openBlockers,
	TASK_STATUSES,
	type TaskEnv,
	type TaskRec,
	taskLine,
	taskText,
	type UpdateInput,
	updateTask,
} from "./team-tasks.ts";

const taskShape = {
	id: Type.String(),
	subject: Type.String(),
	description: Type.String(),
	status: StringEnum(TASK_STATUSES),
	owner: Type.Optional(Type.String()),
	blockedBy: Type.Array(Type.String(), { description: "Ids of the tasks it waits for" }),
	result: Type.Optional(Type.String()),
	createdBy: Type.String(),
};
const taskSchema = Type.Object(taskShape);

const createParameters = Type.Object({
	subject: Type.String({ description: "What the task is, in a few words" }),
	description: Type.Optional(
		Type.String({ description: "What to do and how to tell it is done; the reader has no other context" }),
	),
	blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Ids of tasks that must be completed first" })),
});
const getParameters = Type.Object({ id: Type.String({ description: "The task's id" }) });
const listParameters = Type.Object({});
const updateParameters = Type.Object({
	id: Type.String({ description: "The task's id" }),
	status: Type.Optional(
		StringEnum(TASK_STATUSES, {
			description:
				"in_progress claims a pending task for yourself; completed finishes yours; pending releases yours (the lead also reopens a completed one)",
		}),
	),
	owner: Type.Optional(
		Type.String({
			description: 'Lead only, without a status: give a pending task to a member ("" takes the owner away)',
		}),
	),
	subject: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	blockedBy: Type.Optional(
		Type.Array(Type.String(), { description: "Replaces the list of tasks this one waits for" }),
	),
	result: Type.Optional(Type.String({ description: "What was done, when you complete it" })),
});

export const TASK_TOOL_DESCRIPTIONS = {
	TaskCreate:
		"Add a task to the team's shared task list. Returns it with its id. `blockedBy` lists tasks that must be completed before it can be claimed.",
	TaskGet: "Read one task of the team's task list in full: description, blockers, owner and result.",
	TaskList:
		"List the team's tasks: id, status, owner, subject and the blockers still open. A task can be claimed when it is pending, unowned and has none open.",
	TaskUpdate:
		'Change a task. Claim a pending, unblocked task for yourself with `status: "in_progress"` (it throws `blocked` or `conflict` if you cannot); finish yours with `status: "completed"` and a `result`; hand it back with `status: "pending"`. Only the lead gives a task to someone (`owner`, no status) or reopens a completed one; only a task\'s creator or the lead edits its subject, description or blockedBy.',
} as const;

const result = (text: string, data: object) => ({
	content: [{ type: "text" as const, text }],
	details: data as never,
	structuredContent: data as unknown as JsonValue,
	isError: false,
});

const view = (t: TaskRec) => ({ ...t });

export interface TaskToolsOptions {
	exposure: "codemode" | "direct";
	// The caller's environment, per call (the lead's session may change, a teammate's is fixed).
	env: (ctx: ExtensionContext, write: boolean) => TaskEnv;
}

// The four tools as they are registered.
export function taskTools(options: TaskToolsOptions) {
	const base = { effect: "write" as const, exposure: options.exposure };
	return [
		{
			...base,
			name: "TaskCreate",
			label: "TaskCreate",
			description: TASK_TOOL_DESCRIPTIONS.TaskCreate,
			parameters: createParameters,
			outputSchema: taskSchema,
			async execute(
				_id: string,
				params: Static<typeof createParameters>,
				_signal: unknown,
				_update: unknown,
				ctx: ExtensionContext,
			) {
				const env = options.env(ctx, true);
				const task = await createTask(env, params);
				return result(`Created task #${task.id}: ${task.subject}`, view(task));
			},
		},
		{
			...base,
			effect: "read" as const,
			name: "TaskGet",
			label: "TaskGet",
			description: TASK_TOOL_DESCRIPTIONS.TaskGet,
			parameters: getParameters,
			outputSchema: Type.Object({ ...taskShape, openBlockers: Type.Array(Type.String()) }),
			async execute(
				_id: string,
				params: Static<typeof getParameters>,
				_signal: unknown,
				_update: unknown,
				ctx: ExtensionContext,
			) {
				const env = options.env(ctx, false);
				const task = getTask(env, String(params.id));
				return result(taskText(env.dir, task), {
					...view(task),
					openBlockers: openBlockers(env.dir, task),
				});
			},
		},
		{
			...base,
			effect: "read" as const,
			name: "TaskList",
			label: "TaskList",
			description: TASK_TOOL_DESCRIPTIONS.TaskList,
			parameters: listParameters,
			outputSchema: Type.Object({
				tasks: Type.Array(Type.Object({ ...taskShape, openBlockers: Type.Array(Type.String()) })),
			}),
			async execute(_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: ExtensionContext) {
				const env = options.env(ctx, false);
				const tasks = listTasks(env);
				const text =
					tasks.length === 0 ? "The task list is empty." : tasks.map((t) => taskLine(env.dir, t)).join("\n");
				return result(text, {
					tasks: tasks.map((t) => ({
						...view(t),
						openBlockers: t.status === "completed" ? [] : openBlockers(env.dir, t),
					})),
				});
			},
		},
		{
			...base,
			name: "TaskUpdate",
			label: "TaskUpdate",
			description: TASK_TOOL_DESCRIPTIONS.TaskUpdate,
			parameters: updateParameters,
			outputSchema: Type.Object({ ...taskShape, warning: Type.Optional(Type.String()) }),
			async execute(
				_id: string,
				params: Static<typeof updateParameters>,
				_signal: unknown,
				_update: unknown,
				ctx: ExtensionContext,
			) {
				const env = options.env(ctx, true);
				const done = await updateTask(env, { ...params, id: String(params.id) } as UpdateInput);
				const text = `${taskLine(env.dir, done.task)}${done.warning ? `\nWarning: ${done.warning}` : ""}`;
				return result(text, { ...view(done.task), ...(done.warning ? { warning: done.warning } : {}) });
			},
		},
	];
}
