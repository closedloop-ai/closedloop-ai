export type KeyboardActivationEvent = {
  key: string;
  currentTarget: object;
  target: object;
  defaultPrevented: boolean;
  preventDefault: () => void;
};

export function keyboardEvent(
  key: string,
  currentTarget: object,
  target: object
): KeyboardActivationEvent {
  return {
    currentTarget,
    defaultPrevented: false,
    key,
    preventDefault() {
      this.defaultPrevented = true;
    },
    target,
  };
}
