export default class Loading {
	_state: 'ON' | 'OFF' = 'ON';
	private _ele: HTMLDivElement;
	private _eleText: HTMLDivElement;

	constructor() {
		this._ele = document.querySelector<HTMLDivElement>('#loading')!;
		this._eleText = document.querySelector<HTMLDivElement>('#loadingText')!;
	}

	on() {
		if (this._state === 'ON') return;

		this._state = 'ON';
		this._ele.style.display = 'flex';
	}

	off() {
		if (this._state === 'OFF') return;

		this._state = 'OFF';
		this._ele.style.display = 'none';
	}

	setText(text: string) {
		this._eleText.innerText = text;
	}
}