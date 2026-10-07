/**
 * Lead-pinned cross-Mac scenario context v1. All operations are async and act
 * on the TARGET host, never on the controller's production socket or auth.
 * @typedef {{host:'m1'|'mbp', cmux:'prod-0.64.22'|'nightly', cmuxVersion:string, cmuxlayerSha:string}} Target
 * @typedef {{text:string, parsed:object|null, column:number|null, column_count:number|null}} Screen
 * @typedef {Object} ScenarioContext
 * @property {Target} target
 * @property {(name:string,args:object)=>Promise<object>} call Raw decoded MCP result; caller requests verbose when needed.
 * @property {(opts:object)=>Promise<object>} spawn Verbose spawn_agent receipt; runner owns every spawned seat.
 * @property {(agentId:string,opts:object)=>Promise<object>} resume Verbose spawn_agent({resume_agent_id,...opts}) receipt.
 * @property {(agentId:string)=>Promise<object>} close close_surface({agent_id,scope:'agent',force:true}); runner still sweeps.
 * @property {(opts:object)=>Promise<object>} send Verbose send_to; default mode:'agent', options passed through.
 * @property {(surface:string,key:string)=>Promise<object>} key send_to({mode:'key',surface,text:key}).
 * @property {(surface:string)=>Promise<Screen>} readScreen Independent cmux socket text, every row/blank/composer preserved.
 * @property {(surface:string,predicate:(screen:Screen)=>boolean,ms:number)=>Promise<Screen>} waitScreen First match, else WaitTimeout{last}.
 * @property {(agentId:string)=>Promise<object>} inspectAgent Full list_agents result's first agent.
 * @property {()=>Promise<string>} focusedSurface Focused target cmux surface ref from socket.
 * @property {(agentId:string)=>Promise<string>} processArgs Actual pane child CLI argv via target ps, never requested args.
 * @property {(agentId:string,seconds:number)=>Promise<object>} busy Minimal sleep prompt; resolves once screen is working.
 * @property {(label:string,value:unknown)=>Promise<string>} receipt Write evidence and return target/run evidence path.
 * @property {(name:string,data:unknown)=>Promise<string>} artifact Write run evidence and return path.
 */
export {};
