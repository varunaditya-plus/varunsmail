import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { registerMcpWorkflowTools } from './mcp-workflow-tools';
import { defaultUserSettings } from '../../lib/schemas';

const mocks = vi.hoisted(() => ({
  workflows: {
    createBundle: vi.fn(),
    createRule: vi.fn(),
  },
  notes: {
    getThreadNotes: vi.fn(),
  },
  db: {
    findUserConnection: vi.fn(),
    findUserSettings: vi.fn(),
    insertUserSettings: vi.fn(),
    updateUserSettings: vi.fn(),
  },
  getZeroDB: vi.fn(),
}));

vi.mock('../../env', () => ({ env: {} }));
vi.mock('../../lib/mailbox-workflows', () => ({
  MailboxWorkflows: class {
    constructor() {
      return mocks.workflows;
    }
  },
}));
vi.mock('../../lib/notes-manager', () => ({
  NotesManager: class {
    constructor() {
      return mocks.notes;
    }
  },
}));
vi.mock('../../lib/server-utils', () => ({ getZeroDB: mocks.getZeroDB }));

type RegisteredTool = {
  inputSchema: z.ZodRawShape;
  handler: (input: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
  }>;
};

function setup() {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(
      name: string,
      config: { inputSchema: z.ZodRawShape },
      handler: RegisteredTool['handler'],
    ) {
      tools.set(name, { inputSchema: config.inputSchema, handler });
    },
  };
  registerMcpWorkflowTools(server as unknown as McpServer, 'owner');

  return {
    tools,
    invoke(name: string, input: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} was not registered`);
      return tool.handler(z.object(tool.inputSchema).parse(input));
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getZeroDB.mockResolvedValue(mocks.db);
});

describe('MCP workflow tools', () => {
  it('registers every workflow, notes, and settings family', () => {
    const { tools } = setup();

    expect([...tools.keys()]).toEqual([
      'mail_activity',
      'mail_assets',
      'mail_smart_folders',
      'mail_cleanup',
      'mail_reminders',
      'mail_screening',
      'mail_rules',
      'mail_bundles',
      'mail_focus',
      'mail_notes',
      'mail_settings',
    ]);
  });

  it('dispatches structured rule and bundle inputs without changing service arguments', async () => {
    const { invoke } = setup();
    mocks.workflows.createRule.mockResolvedValue({ rule: { id: 'rule' } });
    mocks.workflows.createBundle.mockResolvedValue({ id: 'bundle' });

    await invoke('mail_rules', {
      action: 'create',
      connectionId: 'mailbox',
      threadId: 'thread',
      ruleAction: 'label',
      labelId: 'Label_1',
    });
    await invoke('mail_bundles', {
      action: 'create',
      name: 'News',
      matchers: [{ connectionId: null, kind: 'newsletter', value: null }],
    });

    expect(mocks.workflows.createRule).toHaveBeenCalledWith(
      'mailbox',
      'thread',
      'label',
      'Label_1',
    );
    expect(mocks.workflows.createBundle).toHaveBeenCalledWith({
      name: 'News',
      deliveryMode: 'immediate',
      deliveryTimes: [],
      timezone: undefined,
      enabled: undefined,
      matchers: [{ connectionId: null, kind: 'newsletter', value: null }],
    });
  });

  it('scopes thread notes with an owned connection and a composite key', async () => {
    const { invoke } = setup();
    mocks.db.findUserConnection.mockResolvedValue({ id: 'mailbox' });
    mocks.notes.getThreadNotes.mockResolvedValue([{ id: 'note' }]);

    await invoke('mail_notes', {
      action: 'list',
      connectionId: 'mailbox',
      threadId: 'thread',
    });

    expect(mocks.db.findUserConnection).toHaveBeenCalledWith('mailbox');
    expect(mocks.notes.getThreadNotes).toHaveBeenCalledWith('owner', 'mailbox:thread');
  });

  it('rejects notes for a connection outside the owner account', async () => {
    const { invoke } = setup();
    mocks.db.findUserConnection.mockResolvedValue(undefined);

    await expect(
      invoke('mail_notes', {
        action: 'list',
        connectionId: 'other-mailbox',
        threadId: 'thread',
      }),
    ).rejects.toThrow('Mailbox connection not found');
    expect(mocks.notes.getThreadNotes).not.toHaveBeenCalled();
  });

  it('preserves existing settings when saving one field', async () => {
    const { invoke } = setup();
    const existing = {
      ...defaultUserSettings,
      language: 'fr',
      trackingProtection: false,
      animations: true,
    };
    mocks.db.findUserSettings.mockResolvedValue({ settings: existing });

    await invoke('mail_settings', { action: 'save', settings: { language: 'es' } });

    expect(mocks.db.updateUserSettings).toHaveBeenCalledWith({ ...existing, language: 'es' });
  });
});
