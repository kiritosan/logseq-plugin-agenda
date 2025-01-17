import { transformBlockToEvent } from './transform'
import { getInitalSettings } from '@/util/baseInfo'
import { TodoistApi, Task, UpdateTaskArgs, AddTaskArgs } from '@doist/todoist-api-typescript'
import { IEvent } from '@/util/events'
import dayjs from 'dayjs'
import { format } from 'date-fns'
import { log } from '@/util/util'

export const PRIORITY_MAP = {
  4: 'A',
  3: 'B',
  2: 'C',
  1: undefined,
}

let instance: TodoistApi | null = null
export const getTodoistInstance = (token?: string) => {
  if (instance && !token) return instance
  if (token) return instance = new TodoistApi(token)

  const { todoist } = getInitalSettings()
  if (todoist?.token) return instance = new TodoistApi(todoist.token)
}


export const pullTask = async () => {
  log('\n=== Start synchronizing tasks from todoist ... ===\n', '#d27e24')
  if (!instance) return logseq.App.showMsg('Please check your todoist configuration', 'error')
  const settings = getInitalSettings()
  const { preferredDateFormat } = await logseq.App.getUserConfigs()
  const { todoist } = settings
  let tasks: Task[] = []

  if (todoist?.sync === 1) {
    if (!todoist.project) {
      logseq.UI.showMsg("Missing project, cannot sync using the project sync option", 'error');
    }
    tasks = await instance.getTasks({ projectId: todoist.project });
  } else if (todoist?.sync === 2 && todoist.filter) {
    if (!todoist.filter) {
      logseq.UI.showMsg("Missing filter, cannot sync using the filter sync option", 'error');
    }
    tasks = await instance.getTasks({ filter: todoist.filter });
  } else {
    tasks = await instance.getTasks()
  }

  const blocks = await getTodoistBlocks()
  const events = await Promise.all(blocks?.map(block => transformBlockToEvent(block, settings)) || [])
  console.info('[faiz: pull totoist] === todoist active tasks:', tasks)
  console.info('[faiz: pull totoist] === exists logseq events:', events)

  let needUpdateEvents: (IEvent & { todoistTask?: Task })[] = []
  let needCreateTasks: Task[] = []

  tasks.forEach(task => {
    const correspondEvent = events.find(event => event.properties?.todoistId === task.id)
    if (!correspondEvent) return needCreateTasks.push(task)
    if (isEventNeedUpdate(correspondEvent, task)) return needUpdateEvents.push({ ...correspondEvent, todoistTask: task })
  })
  const eventsNotInActiveTasksPromise = events
    .filter(event => event.addOns.status !== 'done')
    .filter(event => !tasks.find(task => task.id === event.properties?.todoistId))
    .map(async event => ({ ...event, todoistTask: await instance?.getTask(event.properties?.todoistId) }))
  const eventsNotInActiveTasksRes = await Promise.allSettled(eventsNotInActiveTasksPromise)
  const eventsNotInActiveTasks = eventsNotInActiveTasksRes.map(res => {
    if (res.status === 'rejected') return null
    return res.value
  }).filter(Boolean)
  // @ts-ignore
  needUpdateEvents = [...needUpdateEvents, ...eventsNotInActiveTasks]

  // console.log('[faiz: pull todoist] === needUpdateEvents', needUpdateEvents)
  // console.log('[faiz: pull todoist] === needCreateTasks', needCreateTasks)
  // console.log('[faiz: pull todoist] === eventsNotInActiveTasks', eventsNotInActiveTasks)

  needCreateTasks.forEach(task => createBlock(task, preferredDateFormat))
  needUpdateEvents.forEach(event => updateBlock(event, event.todoistTask))

  logseq.App.showMsg(`Get todoist data successfully:\n${needCreateTasks.length} new tasks created\n${needUpdateEvents.length} tasks updated`)

  log('\n=== Synchronizing tasks from todoist success ===\n', 'green')
}
export const updateTask = (id: number, params: UpdateTaskArgs) => instance?.updateTask(id, params)
export const getTask = (id: number) => instance?.getTask(id)
export const closeTask = (id: number) => instance?.closeTask(id)
export const reopenTask = (id: number) => instance?.reopenTask(id)
export const createTask = (args: AddTaskArgs) => instance?.addTask(args)

export const destroy = () => {
  instance = null
}

export const getTodoistBlocks = async () => {
  const query = '(and (task todo doing done waiting canceled later now) (property todoist-id))'
  return logseq.DB.q(query)
}

// If the logseq block is inconsistent with todoist task, the block needs to be updated.
export const isEventNeedUpdate = (event: IEvent, task: Task) => {
  const _completed = event.addOns.status === 'done'
  const _datetime = event.rawTime ? dayjs(event.rawTime?.start).valueOf() : undefined
  const _content = event.addOns.contentWithoutTime?.split('\n')[0]
  const _description = event.properties?.todoistDesc || ''
  const _priority = event.priority

  const { completed, due, content, priority, description = '' } = task
  let datetime = due ? (
    due?.datetime ? dayjs(due?.datetime).valueOf() : dayjs(due.date).valueOf()
  ) : undefined
  if (_completed !== completed || _content !== content || _description !== description || _datetime !== datetime || _priority !== PRIORITY_MAP[priority]) return true
  return false
}

export const createBlock = async (task: Task, dateFormat: string) => {
  const { todoist } = getInitalSettings()
  const date = task.due?.datetime || task.due?.date

  let page
  if (todoist?.position) {
    page = await logseq.Editor.getPage(todoist.position)
  } else {
    const journalName = format(dayjs().valueOf(), dateFormat)
    page = await logseq.Editor.createPage(journalName, {}, { journal: true })
  }

  let content = task.content
  const logseqPriority = PRIORITY_MAP[task.priority]
  if (logseqPriority) content = `[#${logseqPriority}] ${content}`
  content = `TODO ${content}`
  if (date) {
    const template = task.due?.datetime ? 'YYYY-MM-DD ddd HH:mm' : 'YYYY-MM-DD ddd'
    content += `\nSCHEDULED: <${dayjs(date).format(template)}>`
  }
  const description = task?.description?.split('\n')[0] || ''

  return logseq.Editor.insertBlock(page!.originalName, content, {
    isPageBlock: true,
    sibling: true,
    properties: {
      'todoist-id': task.id,
      'todoist-desc': description,
    },
  })
}
export const updateBlock = async (event: IEvent, task?: Task) => {
  if (!task) return

  let content = task.content
  const logseqPriority = PRIORITY_MAP[task.priority]
  if (logseqPriority) content = `[#${logseqPriority}] ${content}`

  content = `${task.completed ? 'DONE' : 'TODO'} ${content}`

  const date = task.due?.datetime || task.due?.date
  if (date) {
    const template = task.due?.datetime ? 'YYYY-MM-DD ddd HH:mm' : 'YYYY-MM-DD ddd'
    content += `\nSCHEDULED: <${dayjs(date).format(template)}>`
  }

  const description = task?.description?.split('\n')[0] || ''

  await logseq.Editor.updateBlock(event.uuid, content)
  // updateBlock will remove all custom properties, so we need to add todoist-id again
  await logseq.Editor.upsertBlockProperty(event.uuid, 'todoist-desc', description)
  return logseq.Editor.upsertBlockProperty(event.uuid, 'todoist-id', task.id)
}