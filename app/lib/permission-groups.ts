import { MANDATORY_ACTION } from "#shared/permissions";
import { actionLabel } from "~/lib/labels";

export interface ActionOption {
  action: string;
  label: string;
}

export interface ActionGroup {
  label: string;
  options: ActionOption[];
}

interface GroupDefinition {
  label: string;
  actions: Record<string, string>;
}

const UNGROUPED_LABEL = "Autres permissions";

const APP_ACTION_GROUPS: Record<string, GroupDefinition[]> = {
  datahub: [{ label: "Imports", actions: { import: "Envoyer", "import-read": "Consulter" } }],
  ago: [{ label: "Administration", actions: { admin: "Administrer AGO" } }],
};

const toOptions = (actions: Record<string, string>, available: Set<string>): ActionOption[] =>
  Object.entries(actions)
    .filter(([action]) => available.has(action))
    .map(([action, label]) => ({ action, label }));

export function appActionGroups(app: string, actions: readonly string[]): ActionGroup[] {
  const available = new Set(actions.filter((action) => action !== MANDATORY_ACTION));
  const definitions = APP_ACTION_GROUPS[app] ?? [];

  const groups = definitions
    .map((definition) => ({ label: definition.label, options: toOptions(definition.actions, available) }))
    .filter((group) => group.options.length);

  const grouped = new Set(definitions.flatMap((definition) => Object.keys(definition.actions)));
  const ungrouped = [...available]
    .filter((action) => !grouped.has(action))
    .map((action) => ({ action, label: actionLabel(app, action) }));

  return ungrouped.length ? [...groups, { label: UNGROUPED_LABEL, options: ungrouped }] : groups;
}
