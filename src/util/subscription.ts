import type { ISchedule } from 'tui-calendar'
import axios from 'axios'
import { formatISO, parseISO } from 'date-fns'
import ical from 'ical.js'
import { genSchedule } from './schedule'
import { ISettingsForm } from './type'
import dayjs from 'dayjs'

/**
 * get ical data
 */
 export const getSubCalendarSchedules = async (subscriptionCalendarList: ISettingsForm['subscriptionList'], defaultDuration?: ISettingsForm['defaultDuration']) => {
  if (!Array.isArray(subscriptionCalendarList)) return []
  const enabledCalendarList = subscriptionCalendarList?.filter(calendar => calendar?.enabled)
  if (!enabledCalendarList?.length) return []

  const resList = await Promise.allSettled(enabledCalendarList.map(calendar => axios.get(calendar.url, { headers: { accept: 'text/calendar' } })))

  const subPromiseList = resList.map(async (res, index) => {
    if (res.status === 'rejected') {
      logseq.App.showMsg(`Get Calendar ${enabledCalendarList[index].id} data error\n${res.reason}`, 'error')
      return []
    }
    try {
      const data = ical.parse(res.value.data)
      const { events } = parseVCalendar(data)
      const buildEventPromiseList: Promise<ISchedule>[] = events.map(async event => {
        const { dtstart, dtend, summary, description } = event
        const hasTime = dtstart.type === 'date-time'

        // Adapted to apple holiday calendar dtend is empty
        let end = dtend?.value || dtstart.value
        if (!hasTime) {
          /**
           * Full day events are available in three formats
           * dtstart 2022-09-09
           * dtend undefined  (apple holiday calendar: https://calendars.icloud.com/holidays/cn_zh.ics)
           * dtend 2022-09-10  (google calendar)
           * dtend 2022-09-09 (https://www.shuyz.com/githubfiles/china-holiday-calender/master/holidayCal.ics)
           */
          const _end = dayjs(end).subtract(1, 'day').endOf('day')
          if (_end.isSameOrAfter(dayjs(dtstart?.value), 'day')) end = _end.format()
        }

        return await genSchedule({
          blockData: { id: new Date().valueOf(), content: `${summary?.value || 'no summary'}\n${description?.value || ''}`, subscription: true },
          category: hasTime ? 'time' : 'allday',
          start: dtstart.value,
          end,
          calendarConfig: enabledCalendarList[index],
          defaultDuration,
          isAllDay: !hasTime,
        })
      })
      return Promise.all(buildEventPromiseList)
    } catch (error) {
      logseq.App.showMsg(`Parse Calendar ${enabledCalendarList[index].id} data error\n${error}`, 'error')
      console.error('[faiz:] === Parse Calendar error', error)
      return []
    }
  })

  const schedulePromiseList = await Promise.allSettled(subPromiseList)
  let schedules: ISchedule[] = schedulePromiseList
                    .filter(item => item?.status === 'fulfilled')
                    // @ts-ignore
                    .map(item => item?.value)
                    ?.flat()

  return schedules
}

export const parseVCalendar = (data: any) => {
  function arrDataToObj(arr: any[]) {
    return arr.reduce((res, cur) => {
      return {
        ...res,
        [cur[0]]: {
          type: cur[2],
          value: cur[3],
        }
      }
    }, {})
  }
  const [calendarType, info, components] = data

  const events = components
                  .filter(component => component[0] === 'vevent')
                  .map(component => {
                    const [type, info, /*properties*/] = component
                    return arrDataToObj(info)
                  })

  return {
    type: calendarType,
    info: arrDataToObj(info),
    events,
  }

}