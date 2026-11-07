/** Locale-owned Antfarm dashboard and workspace-panel copy. */
export const en = {
  brand: 'Antfarm', tagline: 'Your AI workspace', dashboard: 'Overview', eyebrow: 'A LITTLE LESS BUSYWORK',
  readyTitle: 'Your next task starts here',
  headline: 'Make room for your next idea.', intro: 'Hand off the repetitive work. Your agent runs in its own environment, and your files stay with your workspace.',
  newTask: 'New workspace', examples: 'A good place to start', examplesHint: 'Prepared files. Real tools. Results you can keep.',
  spreadsheet: 'Turn a spreadsheet into a clear answer', spreadsheetHint: 'Analyze a sample sales file and create a downloadable report.',
  spreadsheetPrompt: 'Use Python to analyze sales.csv. Calculate revenue by product and total revenue, then write a concise report.md and a summary.csv. Read the generated files to verify the results. Write the report and final answer in English, and link to both files.',
  notes: 'Bring order to scattered notes', notesHint: 'Organize a short project brief into an actionable plan.',
  notesPrompt: 'Read brief.md, organize the requirements into a practical project plan, and write plan.md with milestones and a short checklist. Write the plan and final answer in English. Verify the file and link to it in your answer.',
  ownFiles: 'Start with your own files', ownFilesHint: 'Create a workspace, upload your documents, and tell the agent what you need.',
  ownPrompt: 'Help me work with the files I upload to this workspace.', tryExample: 'Use this example', setup: 'Your workspace, your way',
  setupHint: 'Choose how you want to work. Each workspace keeps its own files.', single: 'One focused conversation',
  singleHint: 'An environment starts for each task and cleans up when the task finishes. Continue the same conversation with your files intact.',
  multi: 'An ongoing project', multiHint: 'Keep several conversations together. Start and stop the shared workspace environment when you need it.',
  name: 'Workspace name', namePlaceholder: 'e.g. Quarterly sales review', create: 'Create workspace', creating: 'Preparing workspace…',
  cancel: 'Cancel', failed: 'Could not prepare the workspace. Please try again.', projects: 'Your workspaces',
  projectsHint: 'Pick up where you left off.', empty: 'Your first workspace starts here', emptyHint: 'Try an example above, or create a workspace for your own files.',
  continue: 'Open workspace', sessionCount: '{n} conversations', private: 'Separate workspace files', retention: 'Keep results after cleanup',
  inference: 'Vultr inference', howTitle: 'From a task to something useful', howOne: 'Bring your files', howOneHint: 'Upload a document or start with a sample.',
  howTwo: 'Watch the work happen', howTwoHint: 'Follow the agent’s commands and file changes.',
  howThree: 'Take the results with you', howThreeHint: 'Download the files and continue whenever you like.',
  modelHint: 'The demo model is ready for visitors. No API key entry is needed.', files: 'Workspace files', filesHint: 'Inputs and results, in one place.',
  upload: 'Upload file', uploading: 'Uploading…', environment: 'Execution environment', closed: 'Environment stopped · files retained',
  uploadFailed: 'Could not upload the file. Please try again.', uploadDisconnected: 'Upload interrupted. Check your connection and try again.',
  running: 'Environment running', starting: 'Preparing environment', closing: 'Cleaning up environment', unknown: 'Checking environment status',
  recovery: 'Environment needs attention', automatic: 'Starts and stops with your tasks', manual: 'Managed for this project',
  retained: 'Closing the environment keeps these files. Your next task can use them again.', workspace: 'Workspace',
}
/** Simplified Chinese dashboard, file-panel, and sample-task copy. */
export const zh = {
  brand: 'Antfarm', tagline: '你的 AI 工作空间', dashboard: '工作台', eyebrow: '少一些琐事，多一些可能',
  readyTitle: '你的下一件事，从这里开始',
  headline: '把时间，留给下一个想法', intro: '把重复的工作交给 AI。它在独立环境里执行，你的文件和成果始终留在工作区。',
  newTask: '新建工作区', examples: '从一件小事开始', examplesHint: '准备好的文件，真实的工具执行，可以带走的成果',
  spreadsheet: '让表格变成清楚的答案', spreadsheetHint: '分析一份销售表格，生成可以下载的报告和汇总',
  spreadsheetPrompt: '请用 Python 分析 sales.csv，计算各产品销售额与总销售额，生成简洁的 report.md 和 summary.csv。读取生成的文件核对结果。请用中文撰写报告和最终回复，解释结论并提供两个文件的链接。',
  notes: '把零散想法，整理成行动', notesHint: '从一份项目简报开始，整理需求、里程碑与待办',
  notesPrompt: '请读取 brief.md，把需求整理成可执行的项目计划，生成 plan.md，包含里程碑和简短待办清单。请用中文撰写计划和最终回复。核对文件内容，最后提供文件链接。',
  ownFiles: '带上你自己的文件', ownFilesHint: '创建工作区，上传文档，再告诉 AI 你需要什么',
  ownPrompt: '请帮我处理上传到这个工作区的文件。', tryExample: '体验这个示例', setup: '选择适合你的工作方式',
  setupHint: '每个工作区都有独立的文件，成果可以在环境回收后继续使用', single: '一次专注的对话',
  singleHint: '任务开始时启动环境，完成后自动回收。继续同一个对话，原文件依然可用。',
  multi: '一个持续的项目', multiHint: '把多个对话放在同一工作区，需要时手动开启或关闭共享环境。',
  name: '工作区名称', namePlaceholder: '例如：季度销售分析', create: '创建工作区', creating: '正在准备工作区…',
  cancel: '取消', failed: '工作区准备失败，请重试', projects: '你的工作区', projectsHint: '从上次停下的地方继续',
  empty: '你的第一个工作区，从这里开始', emptyHint: '体验上面的示例，或者创建工作区并上传自己的文件',
  continue: '打开工作区', sessionCount: '{n} 个对话', private: '工作区文件独立', retention: '环境回收，成果保留',
  inference: 'Vultr 模型', howTitle: '从一个任务，到一份成果', howOne: '带上你的文件', howOneHint: '上传文档，或使用准备好的示例',
  howTwo: '看见工作过程', howTwoHint: '跟随 AI 执行命令、读取和修改文件',
  howThree: '把成果带走', howThreeHint: '下载文件，随时继续下一步', modelHint: '已为游客准备演示模型，无需填写 API 密钥',
  files: '工作区文件', filesHint: '输入文件与生成成果，都在这里', upload: '上传文件', uploading: '正在上传…',
  uploadFailed: '文件上传失败，请重试。', uploadDisconnected: '上传中断，请检查连接后重试。',
  environment: '执行环境', closed: '环境已停止 · 文件保留', running: '环境运行中', starting: '正在准备环境',
  closing: '正在回收环境', unknown: '正在确认环境状态', recovery: '环境需要处理', automatic: '随任务自动启动与回收', manual: '为当前项目手动管理',
  retained: '关闭执行环境会保留这些文件，下一次任务仍然可以使用', workspace: '工作区',
} satisfies Record<keyof typeof en, string>

/** Translation keys shared by the Antfarm presentation dictionaries. */
export type WorkbenchKey = keyof typeof en
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { antfarm: WorkbenchKey }
}
