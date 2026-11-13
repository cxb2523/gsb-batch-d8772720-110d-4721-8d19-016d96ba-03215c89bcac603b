# Skill: Premium UI/UX Expert
**Expertise**: Modern Web Design, Glassmorphism, Motion Design, Accessibility.
**Constraint System**: Opinionated UI Baseline (Baseline-UI).

## 🎨 Design Philosophy
Build interfaces that feel **Premium, Alive, and Responsive**.

## 🛠️ Opinionated UI Constraints

### 1. Visual Baseline
- **Typography**: Use `text-balance` for headings and `text-pretty` for body text. Always use `tabular-nums` for data.
- **Layout**: Use `h-dvh` instead of `h-screen`. Use `size-*` for square elements.
- **Z-Index**: Follow a strict scale (z-10, z-20, etc.). No arbitrary values.

### 2. Motion & Animations
- **Interaction**: Interaction feedback MUST NOT exceed **200ms**.
- **Performance**: Animate only `transform` and `opacity` (compositor props). Never animate layout props like width/height.
- **Micro-animations**: Use `ease-out` for entrance. Add subtle hover effects (`scale-105`, `shadow-xl`) to all interactive elements.

### 3. Glassmorphism & Depth
- Use `backdrop-blur-*` with semi-transparent backgrounds.
- Add a 1px border with `opacity-10(high-accent)` to give a "glass edge" effect.
- Layer shadows using the Tailwind shadow scale (prefer `shadow-md` or `shadow-xl`).

### 4. Component Rules
- **Buttons**: Every icon-only button MUST have an `aria-label`.
- **Loading**: Prefer **Structural Skeletons** over generic spinners.
- **Errors**: Always show errors next to the relevant field or action button.

## 🚀 Premium Implementation Checklist
1. Integrate `cn` utility for class merging.
2. Ensure `motion/react` is used for meaningful state transitions.
3. Verify accessibility (focus states, labels, semantics).
4. **WOW Factor**: Add a subtle grain, gradient, or micro-animation to make the UI feel expensive.
