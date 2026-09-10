export interface ParameterDefinition {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  description: string;
}

export interface ParameterGroup {
  guid: string;
  id: string;
  name: string;
  parentGuid: string | null;
  children: string[];
  expanded: boolean;
}

export interface ParameterKeyEdit {
  parameterGuid: string;
  // previous retains a keyform's shape when moving a key to another value.
  keys: { value: number; previous?: number }[];
}

export interface ParameterPanelState {
  selection: string[];
  collapsed: string[];
  onlyActive: boolean;
  dragLocked: boolean;
  snap: boolean;
}

/** Native folder deletion includes all nested parameters and folders. */
export function parameterDescendants(groups: ParameterGroup[], guids: string[]): string[] {
  const children = new Map(groups.map((g) => [g.guid, g.children]));
  const result = new Set<string>();
  const visit = (guid: string) => {
    if (result.has(guid)) return;
    result.add(guid);
    for (const child of children.get(guid) || []) visit(child);
  };
  guids.forEach(visit);
  return [...result];
}
