import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getRoutines } from "../services/routinesApi";
import { readTasks, subscribeTasks } from "../services/syncEngine";
import type { Routine, Task } from "../types/models";
import { useCachedQuery, type CachedQuery } from "./useCachedQuery";

/** Tasks from the phone's store, live: every change on this device or from a sync re-renders. */
export function useLocalTasks(): Task[] {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void readTasks().then((t) => live && setTasks(t));
    load();
    const off = subscribeTasks(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return tasks;
}

/** The current minute; ticks every minute (the "now" line, overdue marks, "left today"). */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * What Today and Plan both show (UI v3): tasks from the phone's store and routines (with ~3 weeks of occurrences) from
 * the last saved copy, refreshed whenever the screen comes into view. Same source, so the two screens always agree.
 */
export function useDayData(): { tasks: Task[]; routines: Routine[]; routinesQ: CachedQuery<Routine[]>; now: Date } {
  const tasks = useLocalTasks();
  const now = useNow();
  const routinesQ = useCachedQuery<Routine[]>("plan-routines", async () => (await getRoutines()).routines);
  const routines = useMemo(() => routinesQ.data ?? [], [routinesQ.data]);
  useFocusEffect(
    useCallback(() => {
      void routinesQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  return { tasks, routines, routinesQ, now };
}
