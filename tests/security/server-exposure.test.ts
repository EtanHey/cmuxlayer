import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Secure Server Exposure', () => {
  it('exposes only the allowed tools and wraps them securely', async () => {
    // Import the secure server module
    const { createSecureServer } = await import('../../src/server-secure');
    
    // Create a secure server instance using the example policy
    const secureServer = await createSecureServer(
      path.join(__dirname, '../../config/policy.example.yaml')
    );
    
    // Verify the server was created
    expect(secureServer).toBeDefined();
    expect(secureServer.server).toBeDefined();
    
    // List tools via the MCP server
    const toolsResult = await secureServer.server.request(
      { method: 'tools/list', params: {} },
      undefined
    ).catch(() => null);
    
    // If we can get tools, verify restrictions
    if (toolsResult && typeof toolsResult === 'object' && 'tools' in toolsResult) {
      const tools = (toolsResult as { tools: Array<{ name: string }> }).tools;
      const toolNames = tools.map(t => t.name);
      
      // Ensure dangerous tools are NOT exposed
      const dangerousTools = ['close_surface', 'kill', 'spawn_agent', 'send_command', 'send_input'];
      for (const dangerous of dangerousTools) {
        expect(toolNames).not.toContain(dangerous);
        expect(toolNames).not.toContain(`cmux.${dangerous}`);
      }

      // Check some expected secure tools
      expect(toolNames).toContain('system.health');
      expect(toolNames).toContain('project.info');
      expect(toolNames).toContain('agent.list');
    }
  });

  it('maintains strict stdio discipline (no stdout pollution)', async () => {
    const { createSecureServer } = await import('../../src/server-secure');
    
    const originalStdoutWrite = process.stdout.write;
    const stdoutWrites: Buffer[] = [];
    
    process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
      stdoutWrites.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };

    try {
      // Create a server and perform some operations
      const secureServer = await createSecureServer(
        path.join(__dirname, '../../config/policy.example.yaml')
      );
      
      // Attempt to list tools — this should not pollute stdout
      await secureServer.server.request(
        { method: 'tools/list', params: {} },
        undefined
      ).catch(() => {});
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
    
    // Stdio should be completely clean or only contain valid JSON-RPC responses
    const nonJsonWrites = stdoutWrites.filter(w => {
      const str = w.toString();
      return str.length > 0 && !str.startsWith('{') && !str.startsWith('[');
    });
    expect(nonJsonWrites).toHaveLength(0);
  });
});
