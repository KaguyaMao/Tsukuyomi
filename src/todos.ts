export interface TodoItem {
	id: number;
	text: string;
	done: boolean;
}

export class TodoStore {
	items: TodoItem[] = [];
	nextId = 1;

	list(): TodoItem[] {
		return this.items;
	}

	add(text: string): TodoItem {
		const item: TodoItem = { id: this.nextId++, text, done: false };
		this.items.push(item);
		return item;
	}

	toggle(id: number): TodoItem | undefined {
		const item = this.items.find((todo) => todo.id === id);
		if (item) item.done = !item.done;
		return item;
	}

	clear(): number {
		const count = this.items.length;
		this.items = [];
		this.nextId = 1;
		return count;
	}

	snapshot(): { todos: TodoItem[]; nextId: number } {
		return { todos: this.items.map((item) => ({ ...item })), nextId: this.nextId };
	}

	restore(todos: TodoItem[], nextId: number): void {
		this.items = todos.map((item) => ({ ...item }));
		this.nextId = nextId;
	}
}
