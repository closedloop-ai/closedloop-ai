export declare const HERMETIC_GIT_ENV: {
  readonly GIT_CONFIG_GLOBAL: "/dev/null";
  readonly GIT_CONFIG_SYSTEM: "/dev/null";
};

export declare function hermeticGitEnv(
  base?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;
