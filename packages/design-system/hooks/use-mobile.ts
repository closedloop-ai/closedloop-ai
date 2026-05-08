import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // Start with false to match server render and avoid hydration mismatch
  const [isMobile, setIsMobile] = React.useState(false)
  const [hasMounted, setHasMounted] = React.useState(false)

  React.useEffect(() => {
    setHasMounted(true)
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  // Return false until mounted to ensure SSR/client consistency
  return hasMounted ? isMobile : false
}
