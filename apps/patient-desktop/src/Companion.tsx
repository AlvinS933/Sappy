// Animated 3D companion character shown to the patient.
//
// The model (src/assets/models/cloud-creature.glb, made with Meshy AI) has three animations:
//   "Agree_Gesture" (13 s), "Walking" (1 s loop), "Running" (0.6 s loop) — all in place.
// Which one plays is picked from what the app is doing (see COMPANION_ANIMATIONS).
import { Suspense, useEffect, useRef, type CSSProperties } from 'react'
import { Canvas } from '@react-three/fiber'
import { useAnimations, useGLTF } from '@react-three/drei'
import type { Group } from 'three'
import modelUrl from './assets/models/cloud-creature.glb?url'

export type CompanionMood = 'idle' | 'listening' | 'thinking' | 'speaking'

/** Animation (and playback speed) for each mood. Change these to taste. */
const COMPANION_ANIMATIONS: Record<CompanionMood, { clip: string; speed: number }> = {
  idle: { clip: 'Agree_Gesture', speed: 1 },
  listening: { clip: 'Agree_Gesture', speed: 1 },
  thinking: { clip: 'Walking', speed: 0.8 },
  speaking: { clip: 'Agree_Gesture', speed: 1.2 },
}

function Creature({ mood }: { mood: CompanionMood }) {
  const group = useRef<Group>(null)
  // Bundled file only, no Draco/Meshopt decoders (the model doesn't use them): nothing is fetched online.
  const { scene, animations } = useGLTF(modelUrl, false, false)
  const { actions } = useAnimations(animations, group)

  useEffect(() => {
    const { clip, speed } = COMPANION_ANIMATIONS[mood]
    const action = actions[clip]
    if (!action) return
    action.reset().setEffectiveTimeScale(speed).fadeIn(0.4).play()
    return () => {
      action.fadeOut(0.4)
    }
  }, [mood, actions])

  return (
    <group ref={group}>
      <primitive object={scene} />
    </group>
  )
}

/** The character on a transparent background. It fills its container; size it with `style`. */
export function Companion({ mood, style }: { mood: CompanionMood; style?: CSSProperties }) {
  return (
    <div style={{ width: '100%', height: '100%', ...style }}>
      <Canvas
        camera={{ position: [0, 1.05, 3.6], fov: 35 }}
        onCreated={({ camera }) => camera.lookAt(0, 0.95, 0)}
        gl={{ alpha: true, antialias: true }}
        dpr={[1, 2]}
      >
        <ambientLight intensity={1.2} />
        <directionalLight position={[2, 4, 3]} intensity={2} />
        <directionalLight position={[-3, 2, -2]} intensity={0.6} />
        <Suspense fallback={null}>
          <Creature mood={mood} />
        </Suspense>
      </Canvas>
    </div>
  )
}

// Start loading the model as soon as the app starts.
useGLTF.preload(modelUrl, false, false)
