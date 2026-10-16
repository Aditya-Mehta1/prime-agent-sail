export interface DispatchBinding {
	ownsBox: boolean;
	boxId: string;
	guestRepoDir: string;
	guestCwd: string;
	guestStateDir: string;
	guestPython: string;
	guestSkillsDir: string;
	hostResourceDir: string;
	inputs: Record<string, string>;
}
