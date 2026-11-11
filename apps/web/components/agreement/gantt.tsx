'use client';

import '@bryntum/gantt/fontawesome/css/fontawesome.css';
import '@bryntum/gantt/fontawesome/css/solid.css';
import '@bryntum/gantt/gantt.css';
import '@bryntum/gantt/svalbard-light.css';
import { type GridColumnConfig, StringHelper, type TaskModel } from '@bryntum/gantt';
import { BryntumGantt } from '@bryntum/gantt-react';
import { useEffect, useMemo, useRef } from 'react';

export interface GanttTask {
  id: string;
  name: string;
  startDate: Date;
  endDate?: Date;
  duration?: number;
  manuallyScheduled: true;
  expanded?: boolean;
  rollup?: boolean;
  draggable?: boolean;
  resizable?: boolean;
  eventColor?: string;
  cls?: string;
  children?: GanttTask[];
}

export interface GanttDependency {
  id: string;
  fromTask: string;
  toTask: string;
  type?: number;
  cls?: string;
}

interface GanttProps {
  tasks: GanttTask[];
  dependencies: GanttDependency[];
  start: Date;
  end: Date;
  today: Date;
  preset: 'weekAndMonth' | 'monthAndYear';
  /** The text shown after a milestone diamond, by task id. */
  labels: Record<string, string>;
  /** Hover text for a task, one entry per line, by task id. The first line is the heading. */
  tips: Record<string, string[]>;
  /** Called after the user drags or resizes a phase. */
  onPhaseMoved: (taskId: string, start: Date, end: Date) => void;
  /** True while a bar is held, so the caller does not swap the data underneath it. */
  onDragging: (dragging: boolean) => void;
  /** Phases that are delivered and cannot move. */
  lockedIds: string[];
  /** A delivered phase was grabbed; it cannot move. */
  onLocked: (phaseName: string) => void;
}

const COLUMNS: GridColumnConfig[] = [
  { type: 'name', field: 'name', text: 'Delivery and payments', width: 220 } as GridColumnConfig,
  { type: 'startdate', text: 'Date', width: 96, format: 'MMM D' } as GridColumnConfig,
];

const renderTask = ({ taskRecord }: { taskRecord: TaskModel }) =>
  taskRecord.isMilestone || taskRecord.isParent ? '' : StringHelper.encodeHtml(taskRecord.name);

export default function Gantt(props: GanttProps) {
  const {
    tasks,
    dependencies,
    start,
    end,
    today,
    preset,
    labels,
    tips,
    onPhaseMoved,
    onDragging,
    onLocked,
    lockedIds,
  } = props;
  const ganttRef = useRef<BryntumGantt>(null);
  // Where the reader was looking: today on first load, the moved phase after a drag.
  const focus = useRef<Date | null>(today);

  const timeRanges = useMemo(() => [{ id: 'today', name: 'Today', startDate: today }], [today]);

  // Bryntum rebinds a listener whenever its prop changes identity, which can drop a drag in
  // progress. The handlers below never change; they read the latest callbacks through refs.
  const moved = useRef(onPhaseMoved);
  moved.current = onPhaseMoved;
  const held = useRef(onDragging);
  held.current = onDragging;
  const locked = useRef(onLocked);
  locked.current = onLocked;
  const lockedSet = useRef(new Set(lockedIds));
  lockedSet.current = new Set(lockedIds);
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const tipsRef = useRef(tips);
  tipsRef.current = tips;
  const handlers = useMemo(
    () => ({
      onDragStart: () => held.current(true),
      onBeforeDrag: ({ taskRecord }: { taskRecord: TaskModel }) => {
        if (!String(taskRecord.id).startsWith('phase:')) return false;
        if (lockedSet.current.has(String(taskRecord.id))) {
          locked.current(taskRecord.name);
          return false;
        }
        return true;
      },
      onBeforeResize: ({ taskRecord }: { taskRecord: TaskModel }) =>
        String(taskRecord.id).startsWith('phase:') && taskRecord.resizable !== false,
      onAfterDrop: () => held.current(false),
      onDrop: ({ taskRecords }: { taskRecords: TaskModel[] }) => {
        for (const t of taskRecords) {
          if (String(t.id).startsWith('phase:') && t.startDate && t.endDate) {
            focus.current = t.startDate as Date;
            moved.current(String(t.id), t.startDate as Date, t.endDate as Date);
          }
        }
      },
      onResizeEnd: ({ changed, taskRecord }: { changed: boolean; taskRecord: TaskModel }) => {
        held.current(false);
        if (
          changed &&
          String(taskRecord.id).startsWith('phase:') &&
          taskRecord.startDate &&
          taskRecord.endDate
        ) {
          moved.current(
            String(taskRecord.id),
            taskRecord.startDate as Date,
            taskRecord.endDate as Date,
          );
        }
      },
      tooltip: {
        // Our own words for each bar and payment, read through a ref so polling never rebinds it.
        template: ({ taskRecord }: { taskRecord: TaskModel }) => {
          const lines = tipsRef.current[String(taskRecord.id)];
          if (!lines || lines.length === 0) return '';
          const [head, ...rest] = lines;
          return `<div class="cw-tip"><strong>${StringHelper.encodeHtml(head ?? '')}</strong>${rest
            .map((l) => `<div>${StringHelper.encodeHtml(l)}</div>`)
            .join('')}</div>`;
        },
      },
      labels: {
        right: {
          field: 'name',
          editor: false,
          renderer: ({ taskRecord }: { taskRecord: TaskModel }) =>
            taskRecord.isMilestone
              ? StringHelper.encodeHtml(labelsRef.current[String(taskRecord.id)] ?? '')
              : '',
        },
      },
    }),
    [],
  );

  // After new data arrives the view would jump to its start; bring the reader back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the drawn data changes.
  useEffect(() => {
    const target = focus.current;
    const gantt = ganttRef.current?.instance;
    if (!target || !gantt) return;
    const timer = setTimeout(() => {
      void gantt.scrollToDate(target, { block: 'center', animate: false });
    }, 50);
    return () => clearTimeout(timer);
  }, [tasks]);

  return (
    <BryntumGantt
      ref={ganttRef}
      cls="cw-gantt"
      tasks={tasks}
      dependencies={dependencies}
      columns={COLUMNS}
      startDate={start}
      endDate={end}
      viewPreset={preset}
      rowHeight={40}
      barMargin={9}
      timeRanges={timeRanges}
      // The label would sit on top of the month names; the legend names the orange line instead.
      timeRangesFeature={{ showHeaderElements: false }}
      taskTooltipFeature={handlers.tooltip}
      cellEditFeature={false}
      taskEditFeature={false}
      taskMenuFeature={false}
      dependencyEditFeature={false}
      dependenciesFeature={{ allowCreate: false }}
      percentBarFeature={false}
      rollupsFeature
      projectLinesFeature={false}
      indicatorsFeature={false}
      labelsFeature={handlers.labels}
      taskRenderer={renderTask}
      onBeforeTaskDrag={handlers.onBeforeDrag}
      onBeforeTaskResize={handlers.onBeforeResize}
      onTaskDragStart={handlers.onDragStart}
      onTaskResizeStart={handlers.onDragStart}
      onAfterTaskDrop={handlers.onAfterDrop}
      onTaskDrop={handlers.onDrop}
      onTaskResizeEnd={handlers.onResizeEnd}
    />
  );
}
