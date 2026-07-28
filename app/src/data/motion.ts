import catalog from './motion_catalog.json'
import type { MotionDefinition } from '../types'

export const motionCatalog = catalog as MotionDefinition[]

export const motionById = Object.fromEntries(motionCatalog.map((motion) => [motion.id, motion])) as Record<string, MotionDefinition>

export function getMotionForExercise(exerciseId: string) {
  return motionCatalog.find((motion) => motion.exercise === exerciseId)
}
