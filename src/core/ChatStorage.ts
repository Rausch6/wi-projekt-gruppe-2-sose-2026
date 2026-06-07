// Typdefinition für eine einzelne Chat-Nachricht
export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export class ChatStorage {
    
    // Tag, um die Ki-Notizen zu identifizieren
    private static readonly AI_TAG = 'This-is-a-AI-Chat-Note';

    /**
     * Speichert den gesamten Chat-Verlauf als Notiz unter dem Paper.
     * Überschreibt eine bestehende KI-Notiz oder legt eine neue an.
     * * @param parentItem Das Paper, an das der Chat angehängt werden soll
     * @param messages Das Array der bisherigen Chat-Nachrichten
     */
    static async saveChat(parentItem: Zotero.Item, messages: ChatMessage[]): Promise<void> {
        let chatNote = this.findExistingChatNote(parentItem);

        if (!chatNote) {
            chatNote = new Zotero.Item('note');
            chatNote.parentID = parentItem.id; 
            chatNote.libraryID = parentItem.libraryID; 
        }

        const noteContent = this.generateHtmlContent(messages);
        chatNote.setNote(noteContent);
        
        await chatNote.saveTx(); 
    }


    /**
     * Durchsucht die Anhänge des Papers nach einer bereits existierenden Chat-Notiz.
     */
    static findExistingChatNote(parentItem: Zotero.Item): Zotero.Item | null {
        const noteIDs = parentItem.getNotes();
        for (const id of noteIDs) {
           
            const note = Zotero.Items.get(id) as Zotero.Item;
            if (!note) continue;

            const content = note.getNote();            
            
            if (content.includes(this.AI_TAG)) {
                return note;
            }
        }
        return null;
    }

    /**
     * Hilfsfunktion: Baut das HTML für Zotero zusammen
     */
    private static generateHtmlContent(messages: ChatMessage[]): string {
        let html = `<h2>KI-Assistent Chat-Protokoll</h2>`;
        html += `<p><i>Letztes Update: ${new Date().toLocaleString()}</i></p><hr>`;

        // Sichtbarer Teil für Nutzer;
        for (const msg of messages) {
            if (msg.role === 'system') continue; 
            
            const roleName = msg.role === 'user' ? 'User' : 'AI';
            const color = msg.role === 'user' ? '#0078D7' : '#107C10';

            // Umwandeln von HTML-Zeichen, damit das Layout nicht bricht
            const safeContent = msg.content
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/\n/g, "<br>");
            
            html += `<div style="margin-bottom: 10px;">
                        <strong style="color: ${color};">${roleName}:</strong><br>
                        ${safeContent}
                     </div>`;
        }

        // Unsichtbarer Teil für Nutzer; Systemprompts und rolerweiterte Informationen werden hier als JSON versteckt
        const jsonState = JSON.stringify(messages);
        html += `<div style="display: none;">
                    ${this.AI_TAG}
                    <span id="ki-plugin-state">${jsonState}</span>
                 </div>`;

        return html;
    }
}