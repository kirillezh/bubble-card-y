import { createElement, setLayout, applyScrollingEffect } from "../../tools/utils.js";
import { handleCustomStyles } from '../../tools/style-processor.js';
import setupTranslation from "../../tools/localize.js";
import { addActions } from "../../tools/tap-actions.js";
import { hashCode, intToRGB, parseEventDateTime, sortEvents } from "./helpers.js";

function dateDiffInMinutes(a, b) {
  const MS_PER_MINUTES = 1000 * 60;

  return Math.floor((b - a) / MS_PER_MINUTES);
}

const getEventDateKey = (eventStart) => {
  const d = parseEventDateTime(eventStart);
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const dayOfMonth = d.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${dayOfMonth}`;
};

function mergeConsecutiveEvents(events) {
  if (events.length <= 1) return events;
  
  const merged = [];
  let current = { ...events[0] };
  
  for (let i = 1; i < events.length; i++) {
    const next = events[i];
    const currentEnd = parseEventDateTime(current.end);
    const nextStart = parseEventDateTime(next.start);
    
    // Check if events are consecutive (end time equals start time, or within 1 minute tolerance)
    const timeDiff = nextStart.getTime() - currentEnd.getTime();
    const isConsecutive = timeDiff <= 60000 && timeDiff >= -60000;
    
    // Check if same calendar entity
    const sameEntity = current.entity?.entity === next.entity?.entity;
    
    if (isConsecutive && sameEntity) {
      // Merge: extend current event's end time
      current.end = next.end;
      // Combine summaries if different
      if (current.summary !== next.summary) {
        current.summary = `${current.summary} – ${next.summary}`;
      }
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}


export async function changeEventList(context) {
  const daysOfEvents = Math.max(1, context.config.days ?? 7);

  const now = new Date();
  const start = now.toISOString();

  // End time: remaining hours today + (days-1) full 24-hour periods
  const end = new Date(now);
  end.setDate(end.getDate() + (daysOfEvents - 1));
  end.setHours(23, 59, 59, 999);

  const params = `start=${start}&end=${end.toISOString()}`;

  const promises = context.config.entities.map(async (entity) => {
    const url = `calendars/${entity.entity}?${params}`;
    const events = await context._hass.callApi("get", url);

    return events.map(e => ({...e, entity}));
  });

  const events = await Promise.all(promises);

  context.events = events.flat()
    .sort(sortEvents)
    .slice(0, context.config.limit ?? undefined);
}

export async function changeEvents(context) {
  const t = setupTranslation(context._hass);

  // Cleanup old footer subscription
  if (context.footerUnsubscribe) {
    context.footerUnsubscribe.then(unsub => unsub());
    context.footerUnsubscribe = null;
  }

  // Merge events BEFORE grouping if enabled
  let eventsToProcess = context.events;
  if (context.config.merge_consecutive_events === true) {
      eventsToProcess = mergeConsecutiveEvents(eventsToProcess);
  }

  const eventsGroupedByDay = eventsToProcess.reduce((acc, event) => {
    const dayKey = getEventDateKey(event.start);
    if (!acc[dayKey]) {
      acc[dayKey] = [];
    }
    acc[dayKey].push(event);
    return acc;
  }, {});

  const noEventText = context.config.no_event_text || t("cards.calendar.no_events") || 'No events';

  if (Object.keys(eventsGroupedByDay).length === 0) {
    const today = new Date().toISOString().split('T')[0];
    eventsGroupedByDay[today] = [{
      start: { date: today },
      end: { date: today },
      summary: noEventText,
      entity: { color: 'transparent' }
    }];
  }

  const fragment = new DocumentFragment();
  const getCurrentLocale = context._hass.locale.language;

  Object.keys(eventsGroupedByDay).sort().forEach((day) => {
    const eventDay = parseEventDateTime({date: day});
    const today = new Date();
    
    const dayWrapper = createElement('div', 'bubble-day-wrapper');
    
    // Only create day chip if show_date_number is not false
    if (context.config.show_date_number !== false) {
      const dayNumber = createElement('div', 'bubble-day-number');
      dayNumber.innerHTML = `${eventDay.getDate()}`;

      const dayMonth = createElement('div', 'bubble-day-month');
      dayMonth.innerHTML = eventDay.toLocaleString(getCurrentLocale, { month: 'short' });

      const dayChip = createElement('div', 'bubble-day-chip');
      dayChip.appendChild(dayNumber);
      dayChip.appendChild(dayMonth);
      if (eventDay.getDate() === today.getDate() && eventDay.getMonth() === today.getMonth()) {
        dayChip.classList.add('is-active');
      }
      
      addActions(dayChip, { 
        ...context.config, 
      }, null);
      
      dayWrapper.appendChild(dayChip);
    } else {
      // Add empty spacer to maintain layout
      const spacer = createElement('div', 'bubble-day-chip');
      spacer.style.width = '0';
      spacer.style.height = '0';
      spacer.style.minWidth = '0';
      spacer.style.padding = '0';
      spacer.style.margin = '0';
      dayWrapper.appendChild(spacer);
    }

    const dayEvents = createElement('div', 'bubble-day-events');
    
    // Check if this day has real events (not just "No events")
    const hasRealEvents = eventsGroupedByDay[day].some(e => 
      e.entity?.color !== 'transparent' && e.summary !== noEventText
    );

    eventsGroupedByDay[day].forEach((event) => {
      const isAllDay = event.start.date !== undefined;
      const now = new Date();
      const eventStart = parseEventDateTime(event.start);
      const eventEnd = parseEventDateTime(event.end);

      const eventTime = createElement('div', 'bubble-event-time');
      eventTime.innerHTML = isAllDay ? /*t("cards.calendar.all_day")*/ '' : eventStart.toLocaleTimeString(getCurrentLocale, { hour: 'numeric', minute: 'numeric' });
      if (!isAllDay && context.config.show_end === true) {
        eventTime.innerHTML += ` – ${eventEnd.toLocaleTimeString(getCurrentLocale, { hour: 'numeric', minute: 'numeric' })}`;
      }

      const eventNameWrapper = createElement('div', 'bubble-event-name-wrapper');
      const eventName = createElement('div', 'bubble-event-name');

      const eventText = event.summary || t("cards.calendar.busy");
      applyScrollingEffect(context, eventName, eventText);
      eventNameWrapper.appendChild(eventName);

      const eventColor = createElement('div', 'bubble-event-color');
      eventColor.style.backgroundColor = event.entity.color
        ? event.entity.color.startsWith('#')
          ? event.entity.color
          : `var(--${event.entity.color}-color)`
        : intToRGB(hashCode(event.entity.entity));
      if (event.entity.color === 'transparent') {
        eventColor.style.display = 'none';
      }

      if (context.config.show_place === true && event.location !== null) {
        const eventPlace = createElement('div', 'bubble-event-place');
        applyScrollingEffect(context, eventPlace, event.location);
        eventNameWrapper.appendChild(eventPlace);
      }

      const eventLine = createElement('div', 'bubble-event');
      eventLine.appendChild(eventColor);
      eventLine.appendChild(eventTime);
      eventLine.appendChild(eventNameWrapper);

      // Apply no_event_line_color if no real events
      // Check if this specific event is the "No events" placeholder
      const isNoEventsPlaceholder = event.entity.color === 'transparent' && event.summary === noEventText;

      if (isNoEventsPlaceholder && context.config.no_event_line_color) {
        const lineColor = context.config.no_event_line_color.startsWith('#')
          ? context.config.no_event_line_color
          : `var(--${context.config.no_event_line_color}-color)`;
        eventLine.style.setProperty('--bubble-event-background-color', lineColor);
      }

      addActions(
        eventLine, 
        context.config.event_action,
        event.entity.entity,
        {
          tap_action: { action: "none" },
          double_tap_action: { action: "none" },
          hold_action: { action: "none" }
        }
      );

      const activeColor = 'var(--bubble-event-accent-color, var(--bubble-accent-color, var(--bubble-default-color)))';

      if (!isNoEventsPlaceholder) {
        if (context.config.show_progress === true && isAllDay && eventStart < now) {
          eventLine.style.setProperty('--bubble-event-background-color', activeColor);
        } else if (context.config.show_progress === true && !isAllDay && eventStart < now) {
          const durationDiff = dateDiffInMinutes(eventStart, eventEnd);
          const startDiff = dateDiffInMinutes(eventStart, now);
          const percentage = 100 * startDiff / durationDiff;

          eventLine.style.setProperty('--bubble-event-background-image', `linear-gradient(to right, ${activeColor} ${percentage}%, transparent ${percentage}%)`);
        }
      }
      
      dayEvents.appendChild(eventLine);
    });

    dayWrapper.appendChild(dayEvents);
    fragment.appendChild(dayWrapper);

    if (context.elements.mainContainer.scrollHeight > context.elements.mainContainer.offsetHeight) {
      context.content.classList.add('is-overflowing');
    }
  });

  // Add footer text if configured
  if (context.config.footer_text) {
    const footer = createElement('div', 'bubble-calendar-footer');
    footer.style.color = 'var(--secondary-text-color, rgba(0,0,0,0.6))';
    footer.style.fontSize = '12px';
    footer.style.padding = '8px 16px';
    footer.style.opacity = '0.7';
    footer.style.textAlign = 'right';

    if (context.config.footer_text.includes('{{') || context.config.footer_text.includes('{%')) {
        if (context._hass.connection) {
            footer.innerHTML = 'Loading...';
            try {
                context.footerUnsubscribe = context._hass.connection.subscribeMessage((msg) => {
                    footer.innerHTML = msg.result;
                }, {
                    type: 'render_template',
                    template: context.config.footer_text,
                    variables: {}
                });
            } catch (e) {
                footer.innerHTML = `Template Error: ${e.message}`;
            }
        } else {
             footer.innerHTML = "Error: No connection";
        }
    } else {
        footer.innerHTML = context.config.footer_text;
    }
    fragment.appendChild(footer);
  }

  context.elements.calendarCardContent.innerHTML = '';
  context.elements.calendarCardContent.appendChild(fragment);

  // Handle auto-height
  if (context.config.auto_height === true) {
    context.elements.mainContainer.style.height = 'auto';
    context.elements.mainContainer.style.setProperty('--bubble-calendar-height', 'auto');
  }

  // Update masks after DOM is rendered
  setTimeout(() => updateScrollMasks(context), 0);
}

function updateScrollMasks(context) {
  const content = context.elements.calendarCardContent;
  if (!content) {
    return;
  }

  const canScrollTop = content.scrollTop > 0;
  const canScrollBottom = content.scrollHeight > content.clientHeight &&
                          content.scrollTop < content.scrollHeight - content.clientHeight - 1;

  content.classList.toggle('can-scroll-top', canScrollTop);
  content.classList.toggle('can-scroll-bottom', canScrollBottom);

  // Calculate mask size based on height (16px for small, 32px for large)
  const height = content.clientHeight;
  const maskSize = height <= 100 ? 16 : 32;
  content.style.setProperty('--bubble-calendar-mask-size', `${maskSize}px`);
}

export function changeStyle(context) {
    setLayout(context);
    handleCustomStyles(context);

    if (context.elements?.calendarCardContent) {
      updateScrollMasks(context);

      // Update masks on scroll
      const content = context.elements.calendarCardContent;
      if (content && !content._scrollListener) {
        content._scrollListener = () => updateScrollMasks(context);
        content.addEventListener('scroll', content._scrollListener);
      }
    }
}
