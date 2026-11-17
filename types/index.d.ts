export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type Task = { id: string; content: string; status: TaskStatus }

declare module 'claude-code' {
  interface PluginState {
    'task-progress': {
      /** The current task list. */
      tasks: Task[]
      /** How far along the work is, 0 to 100. */
      percent: number
      /** When Claude expects to be done, ms since the epoch; 0 for none. */
      etaAt: number
    }
  }
}
