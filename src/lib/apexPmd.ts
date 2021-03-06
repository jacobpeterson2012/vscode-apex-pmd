import * as vscode from 'vscode';
import * as ChildProcess from 'child_process'
import * as fs from 'fs';
import * as path from 'path';

let parseSync  =  require('csv-parse/lib/sync');

export class ApexPmd{
    private _pmdPath: string;
    private _rulesetPath: string;
    private _errorThreshold: number;
    private _warningThreshold: number;
    private _outputChannel: vscode.OutputChannel;
    private _outputCols;

    private _statusBarItem: vscode.StatusBarItem;


    public constructor(outputChannel: vscode.OutputChannel, pmdPath: string, defaultRuleset: string, errorThreshold: number, warningThreshold: number){
        this._rulesetPath = defaultRuleset;
        this._pmdPath = pmdPath;
        this._errorThreshold = errorThreshold;
        this._warningThreshold = warningThreshold;
        this._outputChannel = outputChannel;

        this._outputCols = '"Problem","Package","File","Priority","Line","Description","Ruleset","Rule"'
        .replace(/"/g, "")
        .split(',')
        .map( x =>  x.toLowerCase() )
        
         // Create statusbarItem as needed
         if (!this._statusBarItem) {
            this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        }
        // Get the current text editor
        let editor = vscode.window.activeTextEditor;
        // no editor? hide statusBarItem
        if (!editor) {
            this._statusBarItem.hide();
            return;
        }


    }


   // update the statusbar with the issues count
    public updateStatusBarItem(count: number) {
        if (count > 0) {
            // Update the status bar
            this._statusBarItem.text = count !== 1 ? `$(stop) ${count} ISSUES` : '$(stop) 1 ISSUE';
            this._statusBarItem.show();
        } else {
            this._statusBarItem.hide();
        }

    }

    public run(targetPath: string, collection: vscode.DiagnosticCollection){
        if(!this.checkPmdPath() || !this.checkRulesetPath()) return;

        let cmd = this.createPMDCommand(targetPath);
        this._outputChannel.appendLine('PMD Command: ' + cmd);

        ChildProcess.exec(cmd, (error, stdout, stderr) => {
            this._outputChannel.appendLine('error:' +  error);
            this._outputChannel.appendLine('stdout:' +  stdout);
            this._outputChannel.appendLine('stderr:' +  stderr);
            //console.log(`STDOUT: ${stdout.split('\n').length}`)

            let lines = stdout.split('\n').filter(x => x.trim().length > 0);
           
            //console.log(lines.length)
            this.updateStatusBarItem(lines.length-1);

            let problemsMap = new Map<string,Array<vscode.Diagnostic>>();
            for(let i = 0; i < lines.length; i++){
                try{
                    let file = this.getFilePath(lines[i]);

                    let problem = this.createDiagonistic(lines[i]);
                    if(!problem) continue;

                    if(problemsMap.has(file)){
                        problemsMap.get(file).push(problem);
                    }else{
                        problemsMap.set(file,[problem]);
                    }
                }catch(ex){
                    this._outputChannel.appendLine(ex);
                }
            }

            


            problemsMap.forEach(function(value, key){
                let uri = vscode.Uri.file(key);
                vscode.workspace.openTextDocument(uri).then(doc => {
                    //fix ranges to not include whitespace
                    for(let i = 0; i < value.length; i++){
                        let prob = value[i];
                        let line = doc.lineAt(prob.range.start.line);
                        prob.range = new vscode.Range(
                                        new vscode.Position(line.range.start.line, line.firstNonWhitespaceCharacterIndex),
                                        line.range.end
                                    );
                    }
                    collection.delete(uri);
                    collection.set(uri , value);
                }, reason => {
                    console.log(reason);
                    this._outputChannel.appendLine(reason);
                });


            });
        });
    }

   
   // util method to parse the given CSV line and provide object
    parseCSVLine(line: String) {
          //format: "Problem","Package","File","Priority","Line","Description","Ruleset","Rule"
          //console.log(this._outputCols);
          // parse the csv line
          let records = parseSync(line, {columns: this._outputCols} );
          if (records != null && records.length > 0) {
                let item = records[0];
                let pcl = {
                    lineNum: parseInt(item.line) - 1,
                    msg: item.description.replace(/[ ]+/g," "),
                    priority: parseInt(item.priority),

                    file: item.file,
                    package: item.package,
                    ruleset: item.ruleset,
                    rule:item.rule

                }
                //console.log('PCL', pcl);
                return pcl;
          }
          return null;
     
        
        
    }

    createDiagonistic(line: String): vscode.Diagnostic{
        //console.log(`LINE: ${line}`);

        let pcl = this.parseCSVLine(line);
        //console.log(`lineNum: ${pcl.lineNum}\nmsg: ${pcl.msg}\n priority: ${pcl.priority}`)
        // ignore if lineNum is not a number
        if(isNaN(pcl.lineNum)){return null;}

        let level: vscode.DiagnosticSeverity;

        if(pcl.priority <= this._errorThreshold){
            level = vscode.DiagnosticSeverity.Error;
        }else if(pcl.priority <= this._warningThreshold){
            level = vscode.DiagnosticSeverity.Warning;
        }else{
            level = vscode.DiagnosticSeverity.Hint;
        }

        let problem = new vscode.Diagnostic(
            new vscode.Range(new vscode.Position(pcl.lineNum,0)
                            ,new vscode.Position(pcl.lineNum,100)
            ),
            pcl.msg,
            level
        );
        return problem;
    }

    getFilePath(line: String): string{
        let parts = line.split(',');
        return this.stripQuotes(parts[2]);
    }

    createPMDCommand(targetPath: String) : string {
        let cmd = `java -cp "${path.join(this._pmdPath,'lib','*')}" net.sourceforge.pmd.PMD -d "${targetPath}" -f csv -R "${this._rulesetPath}"`;
        console.log(`CMD: ${cmd}`)
        return cmd;
    }

    checkPmdPath(): boolean{
        if(this.dirExists(this._pmdPath)){
            return true;
        }
        this._outputChannel.appendLine(this._pmdPath);
        vscode.window.showErrorMessage('PMD Path not set. Please see Installation Instructions.');
        return false;
    }

    checkRulesetPath(): boolean{
        if(this.fileExists(this._rulesetPath)){
            console.log(`Ruleset Path: ${this._rulesetPath}`)
            return true;
        }
        vscode.window.showErrorMessage(`No Ruleset not found at ${this._rulesetPath}. Ensure configuration correct or change back to the default.`);
        return false;
    }

    //=== Util ===
    fileExists(filePath){
        try{
            let stat = fs.statSync(filePath);
            return stat.isFile();
        }catch (err){
            return false;
        }
    }

    dirExists(filePath){
        try{
            let stat = fs.statSync(filePath);
            return stat.isDirectory();
        }catch (err){
            return false;
        }
    }

    stripQuotes(s : string): string{
        return s.substr(1, s.length-2);
    }
}




