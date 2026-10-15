#ifndef BundleDir
  #error BundleDir is required
#endif
#ifndef ReleaseVersion
  #error ReleaseVersion is required
#endif

[Setup]
AppName=LingoSofa for Discord
AppVersion={#ReleaseVersion}
AppId=LingoSofaDiscord
DefaultDirName={localappdata}\LingoSofa
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=no
CreateAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputBaseFilename=LingoSofa-Setup-{#ReleaseVersion}-win32-x64
Compression=lzma2
SolidCompression=yes
SetupLogging=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
LicenseFile={#BundleDir}\LICENSE

[Files]
Source: "{#BundleDir}\*"; DestDir: "{tmp}\lingo-sofa"; Flags: recursesubdirs createallsubdirs deleteafterinstall

[Code]
var
  DiscordPage: TInputDirWizardPage;
  InstallationSucceeded: Boolean;

function GetCustomSetupExitCode: Integer;
begin
  if InstallationSucceeded then Result := 0 else Result := 1;
end;

procedure InitializeWizard;
begin
  DiscordPage := CreateInputDirPage(wpWelcome, 'Discord installation',
    'Choose the Discord installation to install or update.',
    'LingoSofa installs a custom Vencord build and a shared local assistant. Exit Discord from the tray and close browsers using the assistant before continuing. Existing accounts and settings are preserved. Choose the Discord directory containing app-*.',
    False, '');
  DiscordPage.Add('Discord directory:');
  DiscordPage.Values[0] := ExpandConstant('{param:DISCORDDIR|{localappdata}\Discord}');
end;

[Run]
Filename: "{code:DiscordLauncher}"; Parameters: "{code:DiscordArguments}"; Description: "Start Discord"; Flags: postinstall nowait skipifsilent shellexec

[Code]
function DiscordLauncher(Param: String): String;
begin
  Result := DiscordPage.Values[0] + '\Update.exe';
end;

function DiscordArguments(Param: String): String;
begin
  Result := '--processStart Discord.exe';
  if DirExists(DiscordPage.Values[0]) then begin
    if Pos('ptb', Lowercase(DiscordPage.Values[0])) > 0 then Result := '--processStart DiscordPTB.exe';
    if Pos('canary', Lowercase(DiscordPage.Values[0])) > 0 then Result := '--processStart DiscordCanary.exe';
  end;
end;

function RestartRequested: Boolean;
begin
  Result := ExpandConstant('{param:RESTARTDISCORD|0}') = '1';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  ResultFile, MessageText: String;
  ResultText: AnsiString;
begin
  if CurStep = ssPostInstall then begin
    WizardForm.StatusLabel.Caption := 'Waiting for Discord and the assistant to exit; then installing...';
    ResultFile := ExpandConstant('{tmp}\lingo-sofa-result.txt');
    if not Exec(ExpandConstant('{tmp}\lingo-sofa\{#AssistantDirectory}\runtime\node.exe'),
      '"' + ExpandConstant('{tmp}\lingo-sofa\install.js') + '" "' + DiscordPage.Values[0] + '" "' + ResultFile + '"',
      '', SW_HIDE, ewWaitUntilTerminated, Code) then
      RaiseException('Could not start the bundled installer.');
    if Code <> 0 then begin
      MessageText := 'Installation failed. Your previous installation was retained. Close connected clients and retry.';
      if LoadStringFromFile(ResultFile, ResultText) then MessageText := UTF8Decode(ResultText);
      RaiseException(MessageText);
    end;
    // Silent [Run] entries execute before ssPostInstall. Start only after successful installation.
    if WizardSilent and RestartRequested then begin
      if not Exec(DiscordLauncher(''), DiscordArguments(''), '', SW_SHOWNORMAL, ewNoWait, Code) then
        RaiseException('Installation completed, but Discord could not be started.');
    end;
    InstallationSucceeded := True;
  end;
end;
