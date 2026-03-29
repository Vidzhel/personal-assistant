import { describe, it, expect } from 'vitest';
import { getProjectTabs, registerProjectTabs } from '../components/project/project-tab-registry';

describe('Project Tab Registry', () => {
  it('returns default tabs when no project type specified', () => {
    const tabs = getProjectTabs();
    expect(tabs).toHaveLength(6);
    expect(tabs.map((t) => t.key)).toEqual(['overview', 'tasks', 'agents', 'templates', 'knowledge', 'sessions']);
  });

  it('returns default tabs for unknown project type', () => {
    const tabs = getProjectTabs('nonexistent-type');
    expect(tabs).toHaveLength(6);
    expect(tabs[0].key).toBe('overview');
  });

  it('returns correct labels for default tabs', () => {
    const tabs = getProjectTabs();
    const labels = tabs.map((t) => t.label);
    expect(labels).toEqual(['Overview', 'Tasks', 'Agents', 'Templates', 'Knowledge', 'Sessions']);
  });

  it('allows registering custom tab set for a project type', () => {
    const customTabs = [
      { key: 'dashboard', label: 'Dashboard', component: () => null },
      { key: 'logs', label: 'Logs', component: () => null },
    ];
    registerProjectTabs('custom', customTabs);
    const tabs = getProjectTabs('custom');
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.key)).toEqual(['dashboard', 'logs']);
  });

  it('does not affect default tabs when registering custom type', () => {
    registerProjectTabs('another', [{ key: 'x', label: 'X', component: () => null }]);
    const defaults = getProjectTabs();
    expect(defaults).toHaveLength(6);
  });
});
