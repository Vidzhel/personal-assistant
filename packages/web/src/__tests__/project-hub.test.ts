import { describe, it, expect } from 'vitest';
import {
  getProjectTabs,
  registerProjectTabs,
  type ProjectTabDef,
} from '../components/project/project-tab-registry';

describe('Project Hub — Tab Registry', () => {
  it('default tabs have 4 entries: overview, tasks, knowledge, sessions', () => {
    const tabs = getProjectTabs();
    expect(tabs).toHaveLength(6);
    expect(tabs.map((t) => t.key)).toEqual(['overview', 'tasks', 'knowledge', 'sessions']);
  });

  it('each default tab has a label and component', () => {
    const tabs = getProjectTabs();
    for (const tab of tabs) {
      expect(tab.label).toBeTruthy();
      expect(typeof tab.component).toBe('function');
    }
  });

  it('unknown project type falls back to default tabs', () => {
    const tabs = getProjectTabs('unknown-type');
    expect(tabs).toHaveLength(6);
    expect(tabs[0].key).toBe('overview');
  });

  it('custom project type can register different tabs', () => {
    const customTabs: ProjectTabDef[] = [{ key: 'feed', label: 'Feed', component: () => null }];
    registerProjectTabs('social', customTabs);
    const tabs = getProjectTabs('social');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].key).toBe('feed');
  });

  it('registering custom type does not affect default', () => {
    registerProjectTabs('minimal', [{ key: 'x', label: 'X', component: () => null }]);
    expect(getProjectTabs('default')).toHaveLength(6);
  });
});

describe('Project Hub — Tab Content Mapping', () => {
  it('overview tab component is ProjectOverviewTab', () => {
    const tabs = getProjectTabs();
    const overview = tabs.find((t) => t.key === 'overview');
    expect(overview).toBeDefined();
    expect(overview!.component.name).toBe('ProjectOverviewTab');
  });

  it('tasks tab component is ProjectTasksTab', () => {
    const tabs = getProjectTabs();
    const tasks = tabs.find((t) => t.key === 'tasks');
    expect(tasks).toBeDefined();
    expect(tasks!.component.name).toBe('ProjectTasksTab');
  });

  it('knowledge tab component is ProjectKnowledgeTab', () => {
    const tabs = getProjectTabs();
    const knowledge = tabs.find((t) => t.key === 'knowledge');
    expect(knowledge).toBeDefined();
    expect(knowledge!.component.name).toBe('ProjectKnowledgeTab');
  });

  it('sessions tab component is ProjectSessionsTab', () => {
    const tabs = getProjectTabs();
    const sessions = tabs.find((t) => t.key === 'sessions');
    expect(sessions).toBeDefined();
    expect(sessions!.component.name).toBe('ProjectSessionsTab');
  });
});

describe('Project Hub — AC Verification', () => {
  it('AC4: tabs available are Overview, Tasks, Agents, Templates, Knowledge, Sessions', () => {
    const tabs = getProjectTabs();
    expect(tabs.map((t) => t.label)).toEqual([
      'Overview',
      'Tasks',
      'Agents',
      'Templates',
      'Knowledge',
      'Sessions',
    ]);
  });

  it('AC12: new project type can define its own tab set without modifying core', () => {
    const beforeCount = getProjectTabs('default').length;
    registerProjectTabs('research', [
      { key: 'papers', label: 'Papers', component: () => null },
      { key: 'experiments', label: 'Experiments', component: () => null },
    ]);
    // Default unchanged
    expect(getProjectTabs('default')).toHaveLength(beforeCount);
    // Custom type has its own tabs
    const researchTabs = getProjectTabs('research');
    expect(researchTabs).toHaveLength(2);
    expect(researchTabs.map((t) => t.key)).toEqual(['papers', 'experiments']);
  });

  it('AC11: sessions tab component is NOT the overview tab (no memory editing)', () => {
    const tabs = getProjectTabs();
    const overview = tabs.find((t) => t.key === 'overview');
    const sessions = tabs.find((t) => t.key === 'sessions');
    expect(overview!.component).not.toBe(sessions!.component);
    // SessionsTab name should NOT include 'Memory' or 'Overview'
    expect(sessions!.component.name).not.toContain('Overview');
    expect(sessions!.component.name).not.toContain('Memory');
  });
});
